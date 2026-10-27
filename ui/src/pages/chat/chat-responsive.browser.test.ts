// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { closeBrowserPage, withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  canRunChatLayoutBrowser,
  chromiumExecutablePath,
  createChatLayoutBrowser,
  expectFiniteRect,
  getBoundingBox,
  getRect,
  readUiCss,
  mountMcpAppSurfaceFixture,
  rectsOverlap,
  waitForLayoutSettled,
} from "./chat-layout.browser.test-support.ts";

const TOUCH_TARGET_MIN_PX = 43.5;
const LONG_SESSION_RAIL_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;

const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
let realChatServer: ControlUiE2eServer | null = null;

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  crowdedComposerFooter?: boolean;
  direct?: boolean;
  goalMode?: boolean;
  slashMenu?: boolean;
};

/**
 * Corner radii are expressed as their base step times the live corner scale,
 * so these expectations stay true on engines that draw continuous curvature
 * (`--openclaw-corner-radius-scale: 1.25`) and on engines that do not.
 */
async function readCornerScale(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-corner-radius-scale"),
    ),
  );
}

async function readControl(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const { x, y, width, height, top, bottom } = node.getBoundingClientRect();
    return {
      x,
      y,
      width,
      height,
      top,
      bottom,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
  });
  expectFiniteRect(rect);
  return rect;
}

const readStyles = (page: Page, selector: string, properties: string) =>
  page.locator(selector).evaluate((node, names) => {
    const style = getComputedStyle(node);
    return names.split(" ").map((name) => style.getPropertyValue(name));
  }, properties);

async function readAxis(page: Page, selector: string, axis: "x" | "y", center = false) {
  return page.locator(selector).evaluateAll(
    (nodes, options) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect[options.axis] +
          (options.center ? rect[options.axis === "x" ? "width" : "height"] / 2 : 0)
        );
      }),
    { axis, center },
  );
}

function expectAligned(values: number[]) {
  expect(values.length).toBeGreaterThan(1);
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.5);
}

function nest(classes: string, content: string) {
  return classes
    .split(" > ")
    .reduceRight((child, className) => `<div class="${className}">${child}</div>`, content);
}

const bubbleHtml = (content: string) => nest("chat-bubble > chat-text", content);
const footerHtml = (content: string, persistent = false) =>
  nest(`chat-group-footer${persistent ? " chat-group-footer--persistent-identity" : ""}`, content);

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function activityAlignmentHtml() {
  const disclosure = (classes: string, iconClass: string, content: string, attrs: string) =>
    `<button class="chat-inline-disclosure ${classes}" type="button" ${attrs}>
      <span class="${iconClass}">${iconSvg()}</span>
      <span class="chat-tool-disclosure__content">${content}</span>
      <span class="chat-tool-row__chevron">${iconSvg()}</span>
    </button>`;
  const tool = (name: string, attrs = "") =>
    disclosure(
      "chat-tool-msg-summary chat-tool-row",
      "chat-tool-msg-summary__icon",
      `<span class="chat-tool-msg-summary__label">Bash</span><span class="chat-tool-msg-summary__names">${name}</span>`,
      `aria-expanded="false" ${attrs}`,
    );
  return `<div class="chat-thread" role="log"><div class="chat-thread-inner">
    <div class="chat-group tool"><div class="chat-group-messages" data-tool-column-reference>Inspecting the available tools.</div></div>
    <div class="chat-group tool chat-group--activity chat-group--with-footer">
      ${nest(
        "chat-group-messages > chat-activity-group is-open",
        `
        ${disclosure("chat-activity-group__summary", "chat-activity-group__icon", '<span class="chat-activity-group__label">Activity: 2 tools</span>', 'aria-expanded="true"')}
        <div class="chat-activity-group__body">
          <div class="chat-bubble chat-bubble--tool-shell" data-activity-call-row>
            ${nest("chat-tools-inline > chat-tool-msg-collapse", tool("search a deliberately long workspace path without extra card chrome"))}
          </div>
          ${nest("chat-bubble chat-bubble--tool-shell > chat-tool-msg-collapse", tool("Bash", "data-failed-call-row"))}
        </div>
      `,
      )}
    </div>
  </div></div>`;
}

type AvatarPlacement = "gutter" | "footer" | "none";

// Exercise footer, gutter and no-avatar turns, including footerless work/narration.
function uniformTurnSpacingHtml(placement: AvatarPlacement) {
  const copy = `<div class="chat-group-footer-actions"><button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button></div>`;
  const meta = (name: string, user: boolean) =>
    `<div class="chat-group-footer__meta">${placement === "footer" && user ? '<span class="chat-author-avatar"></span>' : ""}<span class="chat-sender-name">${name}</span></div>`;
  const message = (role: string, modifiers: string, text: string, name?: string) => {
    const identity = name ? meta(name, role === "user") : "";
    const footer = name
      ? footerHtml(
          role === "user" && !modifiers.includes("--peer") ? copy + identity : identity + copy,
          role === "user",
        )
      : '<div class="chat-group-footer" aria-hidden="true"></div>';
    return `<div class="chat-group ${role} ${modifiers} chat-group--with-footer">
      ${placement === "gutter" ? `<div class="chat-avatar ${role}">A</div>` : ""}
      ${nest("chat-group-messages", bubbleHtml(text))}${footer}
    </div>`;
  };
  const tool = (classes: string, summary: string) =>
    nest(
      `chat-group tool chat-group--turn-block ${classes} > chat-group-messages > chat-activity-group chat-work-group`,
      `<button class="chat-inline-disclosure chat-activity-group__summary" type="button">${summary}</button><div class="chat-work-group__separator"></div>`,
    );
  const narration = (text: string) =>
    nest(
      "chat-group assistant chat-group--turn-block chat-group--with-footer > chat-group-messages",
      bubbleHtml(text),
    );
  const turns = [
    message("user", "", "Own prompt", "You"),
    tool("chat-group--work", "Worked for 10s"),
    message("assistant", "", "<p>Done.</p>", "Assistant"),
    message("user", "chat-group--peer", "Peer prompt", "Peer"),
    tool("chat-group--activity chat-group--with-footer", "Activity: 2 tools"),
    message("assistant", "chat-group--meta-revealed", "Revealed reply", "Assistant"),
    message("user", "chat-group--meta-revealed", "Revealed own prompt", "You"),
    narration("Checking the footer layout first."),
    tool("chat-group--activity chat-group--with-footer", "Activity: 1 tool"),
    narration("Comparing the two layouts."),
    message("assistant", "", "Streaming reply"),
  ];
  return `<div class="chat-thread${placement === "footer" ? " chat-thread--direct" : ""}" role="log">
    <div class="chat-thread-inner chat-thread-inner--virtual"><div class="chat-virtual-sizer" style="height: 1600px;">
      ${nest("chat-virtual-block", turns.map((turn) => nest("chat-virtual-row", turn)).join(""))}
    </div></div>
  </div>`;
}

function runBlockSpacingHtml() {
  const turn = (
    role: string,
    marker: string,
    content: string,
    options: { persistent?: boolean; revealed?: boolean; copy?: boolean } = {},
  ) =>
    `<div class="chat-group ${role} chat-group--with-footer${options.revealed ? " chat-group--meta-revealed" : ""}" data-${marker}>
      ${nest("chat-group-messages", content)}
      ${footerHtml(`<span class="chat-sender-name">${role === "user" ? "You" : "Assistant"}</span>${options.copy ? `<div class="chat-group-footer-actions"><button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button></div>` : ""}`, options.persistent)}
    </div>`;
  const block = (name: string, content: string) =>
    `<div class="chat-bubble" data-run-block="${name}"><div class="chat-text">${content}</div></div>`;
  return `<div class="chat-thread chat-thread--direct" role="log"><div class="chat-thread-inner">
    ${turn(
      "assistant",
      "run-turn",
      `
      ${block("text", "Opening text")}
      ${block("detail", "Detail text")}
      <div class="chat-bubble chat-bubble--tool-shell" data-run-block="tool">Tool row</div>
      <div class="chat-activity-group" data-run-block="list">
        <div class="chat-activity-group__body"><div class="chat-group-messages">
          <div class="chat-bubble" data-expanded-row="text">Expanded detail</div>
          <div class="chat-bubble chat-bubble--tool-shell" data-expanded-row="tool">Expanded tool row</div>
        </div></div>
      </div>
      ${block("activity-reply", "Activity result")}
      <div class="chat-activity-group chat-work-group" data-run-block="work">
        <button class="chat-inline-disclosure chat-activity-group__summary" type="button">Worked for 10s</button>
        <div class="chat-work-group__separator"></div>
      </div>
      ${block("reply", "Final reply")}
    `,
      { copy: true },
    )}
    ${turn("user", "next-turn", bubbleHtml("Next turn"))}
    ${turn("user", "persistent-turn", bubbleHtml("Persistent identity turn"), { persistent: true, copy: true })}
    ${turn("assistant", "after-persistent-turn", bubbleHtml("After persistent identity"))}
    ${turn("user", "revealed-persistent-turn", bubbleHtml("Revealed persistent identity"), { persistent: true, revealed: true, copy: true })}
    ${turn("assistant", "after-revealed-turn", bubbleHtml("After revealed identity"))}
  </div></div>`;
}

function chatFooterActionsHtml() {
  return `
    <div class="chat-group-footer-actions">
      <button class="chat-copy-btn" type="button" aria-label="Copy as markdown">
        <span class="chat-copy-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
    </div>
  `;
}

function composerControlsHtml() {
  // Closed-menu geometry only; picker/overflow suites own menu contents and interaction.
  return `
    <div class="agent-chat__composer-controls">
      <div class="chat-composer-model-control">
        <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
          <details class="chat-controls__inline-select chat-controls__model-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" data-chat-composer-model="true" aria-label="Chat model: GPT-5.6 Luna">
            <span class="chat-controls__inline-select-label">GPT-5.6 Luna</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__model-menu"></div>
          </details>
          <details class="chat-controls__inline-select chat-controls__permission-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__permission-trigger" aria-label="Permissions: Guarded">
            <span class="chat-controls__permission-icon" aria-hidden="true">${iconSvg()}</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__permission-menu"></div>
          </details>
          <details class="chat-controls__inline-select chat-controls__effort-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" data-chat-composer-effort="true" aria-label="Effort">
            <span class="chat-controls__inline-select-label">Medium</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__effort-menu"></div>
          </details>
        </div>
      </div>
    </div>
  `;
}

function chatHtml(opts: ChatFixtureOptions = {}, mobileNavLayout = false) {
  const message = (role: string, content: string, footer = "") =>
    `<div class="chat-group ${role}${footer ? " chat-group--with-footer" : ""}">${nest("chat-avatar " + role, role === "user" ? "V" : "A")}${nest("chat-group-messages", content)}${footer}</div>`;
  const messages = `${message("user", bubbleHtml("Keep this visible."))}${message(
    "assistant",
    bubbleHtml("It stays readable.") +
      bubbleHtml(
        '<p>The chat shell should stay compact and readable.</p><div class="code-block-wrapper"><pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre></div>',
      ),
    footerHtml(
      nest(
        "chat-group-footer__meta",
        '<span class="chat-sender-name">Assistant</span><span class="chat-group-timestamp">9:41 PM</span>',
      ) + chatFooterActionsHtml(),
    ),
  )}`;
  const typing = opts.crowdedComposerFooter
    ? `<div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside" role="status"><span class="agent-chat__typing-avatars" aria-hidden="true">${[
        "A",
        "B",
        "C",
      ]
        .map((name) => '<span class="chat-author-avatar">' + name + "</span>")
        .join(
          "",
        )}</span><span class="agent-chat__typing-text">Alexandria, Bartholomew, and Cassandra are typing</span></div>`
    : "";
  const commands = opts.slashMenu
    ? `<div class="slash-menu" role="listbox" aria-label="Command suggestions">${nest(
        "slash-menu-group",
        '<div class="slash-menu-group__label">Commands</div>' +
          [
            ["plan", "Create a plan"],
            ["review", "Review changes"],
            ["fix", "Fix current issue"],
          ]
            .map(
              ([name, description], index) =>
                '<div class="slash-menu-item' +
                (index === 0
                  ? ' slash-menu-item--active" role="option" aria-selected="true">'
                  : '" role="option">') +
                '<span class="slash-menu-icon">' +
                iconSvg() +
                '</span><span class="slash-menu-name">/' +
                name +
                '</span><span class="slash-menu-desc">' +
                description +
                "</span></div>",
            )
            .join(""),
      )}</div>`
    : "";
  const goal = opts.goalMode
    ? nest(
        "agent-chat__goal-mode composer-context-strip",
        `<span class="agent-chat__goal-mode-label composer-context-strip__label"><span class="composer-context-strip__icon">${iconSvg()}</span><span class="composer-context-strip__label-text">Goal</span></span><span class="agent-chat__goal-mode-hint composer-context-strip__text">Enter your objective.</span>`,
      )
    : "";
  const attachment = opts.composerAttachment
    ? nest(
        "chat-attachments-preview > chat-attachment-thumb chat-attachment-thumb--file",
        `${nest(
          "chat-attachment-file",
          '<span class="chat-attachment-file__icon">' +
            iconSvg() +
            '</span><span class="chat-attachment-file__name">landscape-proof-attachment.txt</span>',
        )}<button class="chat-attachment-remove" type="button" aria-label="Remove attachment">&times;</button>`,
      )
    : "";
  const attach = nest(
    "agent-chat__composer-lead",
    `<details class="agent-chat__attach-menu"><summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary><div class="agent-chat__attach-menu-popover" role="menu"></div></details>`,
  );
  const context = nest(
    "agent-chat__composer-meta agent-chat__composer-context > context-usage",
    `<details><summary class="context-ring" role="status" aria-label="Session context usage: 46k/200k (23%)"><svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle class="context-ring__track" cx="8" cy="8" r="6.5"></circle><circle class="context-ring__fill" cx="8" cy="8" r="6.5"></circle></svg></summary></details>`,
  );
  const footer = nest(
    "agent-chat__composer-footer",
    `${attach}${nest(
      "agent-chat__composer-trail",
      context +
        composerControlsHtml() +
        nest(
          "agent-chat__composer-actions",
          '<button class="chat-send-btn chat-send-btn--voice" aria-label="Start voice input">' +
            iconSvg() +
            "</button>",
        ),
    )}`,
  );
  const input = `<div class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar" data-composer-layout="multiline">${commands}${nest(
    "agent-chat__composer-lede",
    goal + attachment + '<div class="agent-chat__composer-status-stack"> </div>',
  )}${nest(
    "agent-chat__composer-input-row > agent-chat__composer-combobox",
    '<textarea rows="1">Queued follow-up for the active operator session</textarea>',
  )}${footer}</div>`;
  return `<div class="shell shell--chat${mobileNavLayout ? " shell--mobile-nav" : ""}" data-chat-responsive-fixture><header class="topbar">${nest(
    "topnav-shell > topnav-shell__actions",
    '<button class="topbar-search">' + iconSvg() + "</button>",
  )}</header><main class="content content--chat"><section class="chat"><div class="chat-split-container"><div class="chat-main" style="flex: 1 1 100%"><div class="chat-thread${opts.direct ? " chat-thread--direct" : ""}" role="log">${nest("chat-thread-inner", messages)}</div>${typing}${nest("agent-chat__composer-shell", input)}</div></div></section></main></div>`;
}

async function syncFixtureComposerPopoverAnchor(page: Page) {
  // The session companion runs the same composer surface, so the pane's own
  // composer is named by its shell rather than by the shared surface class.
  await page.locator(".agent-chat__composer-shell > .agent-chat__input").evaluate((node) => {
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const composerTop = node.getBoundingClientRect().top;
    node.style.setProperty(
      "--chat-composer-popover-max-height",
      `${Math.max(0, composerTop - viewportTop - 28)}px`,
    );
  });
}

async function openFixture(width: number, height: number, opts: ChatFixtureOptions = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts, width <= 1100)}</body></html>`,
    );
    await syncFixtureComposerPopoverAnchor(page);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function openSessionRailFixture(width: number, height: number) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
      <div style="display:flex;height:100dvh">
        <div class="sidebar-region sidebar-region--right sidebar-region--open${width <= 768 ? " sidebar-region--narrow" : ""}" style="--side-panel-width:400px;--side-panel-height:360px">
          <div class="sidebar-region__header">Current session</div>
          <div class="sidebar-region__primary" data-region="main">Conversation</div>
          <div class="sidebar-region__right-runtime">
            <div class="side-panel">
              <header class="rail-header side-panel__header" data-region-header="side">Side chat</header>
              <div class="side-panel__body">
                <div class="side-panel__panel" data-region="side">
                  <openclaw-chat-session-rail>
                    <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded" role="region" aria-label="Side chat">
                      <div class="chat-session-rail__thread">
                        <article class="chat-session-rail__exchange">
                          <div class="chat-group user chat-group--with-footer"><div class="chat-group-messages"><div class="chat-bubble">What should I check next?</div></div></div>
                          <div class="chat-group assistant chat-group--with-footer"><div class="chat-group-messages"><div class="chat-bubble">${LONG_SESSION_RAIL_BODY}</div></div></div>
                          <span class="chat-session-rail__pr-checks">2 passed</span>
                          <div class="chat-session-rail__hint">Side chat is already answering a question.</div>
                        </article>
                      </div>
                      <form class="agent-chat__input chat-session-rail__composer">
                        <div class="agent-chat__composer-input-row">
                          <label class="agent-chat__composer-combobox chat-session-rail__prompt">
                            <textarea class="chat-session-rail__input" rows="1" placeholder="What should I know?"></textarea>
                          </label>
                        </div>
                        <div class="agent-chat__composer-footer">
                          <div class="agent-chat__composer-trail">
                            <div class="agent-chat__composer-actions"><button class="chat-send-btn">${iconSvg()}</button></div>
                          </div>
                        </div>
                      </form>
                    </section>
                  </openclaw-chat-session-rail>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.html).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

describeBrowserLayout.concurrent("chat responsive browser layout", () => {
  beforeAll(async () => {
    await layoutBrowser.start();
    realChatServer = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await realChatServer?.close();
    realChatServer = null;
    await layoutBrowser.close();
  });

  it("waits through delayed layout updates", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      await page.setContent(
        '<div id="delayed-layout" style="position:absolute;top:0">Layout</div>',
      );
      await page.locator("#delayed-layout").evaluate((node) => {
        const element = node as HTMLElement;
        const nativeGetBoundingClientRect = element.getBoundingClientRect.bind(element);
        let scheduled = false;
        element.getBoundingClientRect = () => {
          const rect = nativeGetBoundingClientRect();
          element.dataset.lastObservedTop = String(rect.top);
          if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                element.style.top = "12px";
              });
            });
          }
          return rect;
        };
      });

      await waitForLayoutSettled(page, "#delayed-layout");

      expect(
        await page
          .locator("#delayed-layout")
          .evaluate((node) => Number((node as HTMLElement).dataset.lastObservedTop)),
      ).toBe(12);
    });
  });

  it("keeps a constrained no-face header to one flex gap", async () => {
    await withBrowserPage(openBrowserPage(360, 180), async (page) => {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-pane__header" style="width: 320px;">
            <div class="chat-pane__header-leading">
              <div class="chat-pane__crumbs">
                <span class="chat-pane__session-title">
                  <span class="chat-pane__session-title-text">A deliberately long session title for the no-face header</span>
                </span>
              </div>
            </div>
            <div class="chat-pane__header-trailing">
              <div class="chat-pane__actions">
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">A</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">B</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">C</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const geometry = await page.locator(".chat-pane__header").evaluate((header) => {
        const leading = header.querySelector<HTMLElement>(".chat-pane__header-leading")!;
        const trailing = header.querySelector<HTMLElement>(".chat-pane__header-trailing")!;
        const title = header.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
        const leadingRect = leading.getBoundingClientRect();
        const trailingRect = trailing.getBoundingClientRect();
        return {
          gap: trailingRect.left - leadingRect.right,
          titleClientWidth: title.clientWidth,
          titleScrollWidth: title.scrollWidth,
        };
      });

      expect(geometry.gap).toBeCloseTo(4, 0);
      expect(geometry.titleScrollWidth).toBeGreaterThan(geometry.titleClientWidth);
    });
  });

  it("caps a nested session trail at half the header while ellipsizing both titles", async () => {
    await withBrowserPage(openBrowserPage(720, 180), async (page) => {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 640px;">
            <div class="chat-pane__header chat-pane__header--closable">
              <div class="chat-pane__crumbs">
                <div class="chat-pane__project-row">
                  <div class="chat-pane__workspace-menu">
                    <button class="oc-menu-trigger chat-pane__workspace-chip" type="button">
                      <span class="oc-menu-item__label">${iconSvg()}<span>openclaw</span></span>
                    </button>
                    <div class="oc-overlay oc-menu" popover="manual" role="menu"></div>
                  </div>
                </div>
                <div class="chat-pane__session-trail">
                  <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                  <button class="chat-pane__parent-session" type="button">
                    <span class="chat-pane__parent-session-text">Release preparation with a long parent name</span>
                  </button>
                  <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                  <button class="chat-pane__session-title chat-pane__session-title-button" type="button">
                    <span class="chat-pane__session-title-text">Implementation details with a long child name</span>
                  </button>
                </div>
              </div>
              <div class="chat-pane__actions">
                <button class="btn btn--ghost chat-pane__layout-trigger" type="button" aria-label="Layout">Layout</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const readState = () =>
        page.locator(".chat-pane__header").evaluate((header) => {
          const separators = [...header.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep")];
          const parentText = header.querySelector<HTMLElement>(".chat-pane__parent-session-text")!;
          const childText = header.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
          const parent = header.querySelector<HTMLElement>(".chat-pane__parent-session")!;
          const child = header.querySelector<HTMLElement>(".chat-pane__session-title")!;
          const headerRect = header.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          const childRect = child.getBoundingClientRect();
          return {
            firstSeparator: getComputedStyle(separators[0]!).display,
            secondSeparator: getComputedStyle(separators[1]!).display,
            parentEllipses: parentText.scrollWidth > parentText.clientWidth,
            childEllipses: childText.scrollWidth > childText.clientWidth,
            headerWidth: headerRect.width,
            nestedTrailWidth: childRect.right - parentRect.left,
            overflow: (header as HTMLElement).scrollWidth - (header as HTMLElement).clientWidth,
          };
        });

      const normal = await readState();
      expect(normal).toMatchObject({
        firstSeparator: "block",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(normal.nestedTrailWidth).toBeLessThanOrEqual(normal.headerWidth / 2 + 1);

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "320px";
      });
      const narrow = await readState();
      expect(narrow).toMatchObject({
        firstSeparator: "none",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(narrow.nestedTrailWidth).toBeLessThanOrEqual(narrow.headerWidth / 2 + 1);
    });
  });

  it.each([
    { label: "desktop", width: 1366, height: 900, hasTouch: false },
    { label: "mobile touch", width: 430, height: 720, hasTouch: true },
  ])("keeps activity disclosures compact on $label", async ({ width, height, hasTouch }) => {
    await withBrowserPage(
      openBrowserPage(width, height, { hasTouch, isolated: true }),
      async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${activityAlignmentHtml()}</body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const activityGroup = await getRect(page, ".chat-activity-group");
        const activitySummary = await getRect(page, ".chat-activity-group__summary");
        const failedSummary = await getRect(page, "[data-failed-call-row]");
        const toolColumn = await getRect(page, "[data-tool-column-reference]");
        expect(activitySummary.width).toBeLessThan(activityGroup.width);
        expect(failedSummary.width).toBeLessThan(activityGroup.width);
        expect(activityGroup.left).toBeCloseTo(toolColumn.left, 0);
        const styles = await page.evaluate(() => {
          const activity = document.querySelector<HTMLElement>(".chat-activity-group__summary")!;
          const label = activity.querySelector<HTMLElement>(".chat-activity-group__label")!;
          const chevron = activity.querySelector<HTMLElement>(".chat-tool-row__chevron")!;
          const toolRows = [
            ...document.querySelectorAll<HTMLElement>(
              ".chat-activity-group__body .chat-tool-msg-summary",
            ),
          ];
          const firstToolStyle = getComputedStyle(toolRows[0]!);
          const firstToolRect = toolRows[0]!.getBoundingClientRect();
          const secondToolRect = toolRows[1]!.getBoundingClientRect();
          return {
            activity: getComputedStyle(activity).userSelect,
            activityBackground: getComputedStyle(activity).backgroundColor,
            activityPaddingBlock: [
              getComputedStyle(activity).paddingTop,
              getComputedStyle(activity).paddingBottom,
            ],
            chevronGap: chevron.getBoundingClientRect().left - label.getBoundingClientRect().right,
            tool: firstToolStyle.userSelect,
            toolPaddingBlock: [firstToolStyle.paddingTop, firstToolStyle.paddingBottom],
            toolRowGap: secondToolRect.top - firstToolRect.bottom,
          };
        });
        const { toolRowGap, ...disclosureStyles } = styles;
        expect(disclosureStyles).toEqual({
          activity: "none",
          activityBackground: "rgba(0, 0, 0, 0)",
          activityPaddingBlock: hasTouch ? ["8px", "8px"] : ["5px", "5px"],
          // Summary gap (8px) less the chevron's own -3px inset.
          chevronGap: 5,
          tool: "none",
          toolPaddingBlock: ["3px", "3px"],
        });
        expect(toolRowGap).toBeGreaterThanOrEqual(0);
        expect(toolRowGap).toBeLessThanOrEqual(2);
      },
    );
  });

  it.each([
    { label: "desktop gutter", placement: "gutter", width: 1366, hasTouch: false, turnGap: 16 },
    { label: "narrow touch footer", placement: "footer", width: 320, hasTouch: true, turnGap: 12 },
    { label: "wide touch none", placement: "none", width: 1366, hasTouch: true, turnGap: 12 },
  ] as const)(
    "separates every consecutive turn by the same space on $label",
    async ({ placement, width, hasTouch, turnGap }) => {
      await withBrowserPage(
        openBrowserPage(width, 1800, { hasTouch, isolated: true }),
        async (page) => {
          // Isolate the final-layout contract from the 200ms settle-in transform.
          await page.setContent(
            `<!doctype html><html><head><style>${readUiCss()}</style><style>.chat-group--work { animation: none; }</style></head><body>${uniformTurnSpacingHtml(placement)}</body></html>`,
          );
          await waitForLayoutSettled(page, ".chat-virtual-row .chat-group");

          const reply = page.locator(".chat-group.assistant").first();
          await reply.locator(".chat-bubble").hover();
          const shortFooter = await reply.evaluate((group) => {
            const box = (selector: string) =>
              group.querySelector(selector)!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(group.querySelector(".chat-text p")!);
            return {
              textBottom: range.getBoundingClientRect().bottom,
              bubbleBottom: box(".chat-bubble").bottom,
              actionsTop: box(".chat-group-footer-actions").top,
              nameTop: box(".chat-sender-name").top,
              iconTop: box(".chat-group-footer-actions button svg").top,
            };
          });
          expect(shortFooter.textBottom).toBeLessThanOrEqual(shortFooter.actionsTop - 1);
          expect(shortFooter.nameTop - shortFooter.bubbleBottom).toBeLessThanOrEqual(10);
          expect(shortFooter.iconTop - shortFooter.bubbleBottom).toBeLessThanOrEqual(10);

          const layout = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(".chat-virtual-row > .chat-group")].map(
              (group) => {
                const box = group.getBoundingClientRect();
                const content = group
                  .querySelector<HTMLElement>(":scope > .chat-group-messages")!
                  .getBoundingClientRect();
                const footer = group
                  .querySelector<HTMLElement>(":scope > .chat-group-footer")
                  ?.getBoundingClientRect();
                return {
                  inTurnBlock: group.classList.contains("chat-group--turn-block"),
                  top: box.top,
                  bottom: box.bottom,
                  contentTop: content.top,
                  contentBottom: content.bottom,
                  footer: footer
                    ? {
                        offset: footer.top - content.bottom,
                        height: footer.height,
                        toEdge: box.bottom - footer.bottom,
                      }
                    : null,
                  gapAfter: Number.parseFloat(getComputedStyle(group).marginBlockEnd),
                };
              },
            ),
          );

          for (const [index, group] of layout.entries()) {
            const next = layout[index + 1];
            if (group.inTurnBlock) {
              // Work, activity and live narration blocks belong to the answer's
              // turn: no footer row, only the inline run-frame gap to what follows.
              expect(group.footer).toBeNull();
              expect(group.gapAfter).toBe(8);
              expect(next!.contentTop - group.contentBottom).toBeCloseTo(8, 1);
              continue;
            }
            // Every turn ends in one footer row of the context's size; the turn
            // gap is the only space before whatever comes next.
            expect(group.gapAfter).toBe(turnGap);
            expect(group.footer).toEqual({
              offset: expect.closeTo(2, 1),
              height: 24,
              toEdge: expect.closeTo(0, 1),
            });
            if (next) {
              expect(next.top - group.bottom).toBeCloseTo(turnGap, 1);
              expect(next.contentTop - group.contentBottom).toBeCloseTo(2 + 24 + turnGap, 1);
            }
          }
        },
      );
    },
  );

  it.each([
    { label: "desktop", width: 1366, hasTouch: false },
    { label: "mobile", width: 430, hasTouch: true },
    { label: "wide touch", width: 1366, hasTouch: true },
  ])("keeps transcript turn and run block spacing on $label", async ({ width, hasTouch }) => {
    await withBrowserPage(
      openBrowserPage(width, 900, { hasTouch, isolated: true }),
      async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${runBlockSpacingHtml()}</body></html>`,
        );

        const gaps = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const gap = (before: string, after: string) => rect(after).top - rect(before).bottom;
          return {
            intraTurn: gap('[data-run-block="text"]', '[data-run-block="detail"]'),
            textToTool: gap('[data-run-block="detail"]', '[data-run-block="tool"]'),
            toolToList: gap('[data-run-block="tool"]', '[data-run-block="list"]'),
            listToReply: gap('[data-run-block="list"]', '[data-run-block="activity-reply"]'),
            replyToWork: gap('[data-run-block="activity-reply"]', '[data-run-block="work"]'),
            workToReply: gap('[data-run-block="work"]', '[data-run-block="reply"]'),
            expandedTextToTool: gap('[data-expanded-row="text"]', '[data-expanded-row="tool"]'),
            workedForSeparator: gap(
              '[data-run-block="work"] > button',
              ".chat-work-group__separator",
            ),
            turn: gap('[data-run-block="reply"]', "[data-next-turn] .chat-bubble"),
            persistentTurn: gap(
              "[data-persistent-turn] .chat-bubble",
              "[data-after-persistent-turn] .chat-bubble",
            ),
            revealedPersistentTurn: gap(
              "[data-revealed-persistent-turn] .chat-bubble",
              "[data-after-revealed-turn] .chat-bubble",
            ),
            simpleToPersistentTurn: gap(
              "[data-next-turn] .chat-bubble",
              "[data-persistent-turn] .chat-bubble",
            ),
          };
        });

        expect(gaps).toEqual({
          intraTurn: 2,
          textToTool: 8,
          toolToList: 8,
          listToReply: 8,
          replyToWork: 8,
          workToReply: 8,
          expandedTextToTool: 6,
          workedForSeparator: 0,
          // Footer offset + 24px footer row + turn gap (16px, or 12px on touch).
          turn: hasTouch ? 38 : 42,
          persistentTurn: hasTouch ? 38 : 42,
          revealedPersistentTurn: hasTouch ? 38 : 42,
          simpleToPersistentTurn: hasTouch ? 38 : 42,
        });
      },
    );
  });

  it("keeps custom avatar sizing and the user edge neutral", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}${readStyleSheet("ui/src/styles/identity-avatar.css")}</style></head><body>
        <img class="chat-avatar assistant" src="/avatar/main" alt="Custom" />
        <img class="chat-avatar user" src="/avatar/user" alt="User" />
      </body></html>`);

      for (const role of ["assistant", "user"]) {
        const selector = ".chat-avatar." + role;
        const rect = await readControl(page, selector);
        expect([rect.width, rect.height]).toEqual([36, 36]);
        expect(
          await readStyles(page, selector, "box-sizing object-fit padding border-top-width"),
        ).toEqual(["border-box", "cover", "0px", "0px"]);
      }

      for (const theme of ["dark", "light"]) {
        const edge = await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
          const probe = document.createElement("span");
          probe.style.outline = "1px solid color-mix(in srgb, var(--text) 8%, transparent)";
          document.body.append(probe);
          const neutralOutline = getComputedStyle(probe).outline;
          const avatar = document.querySelector("img.chat-avatar.user");
          if (!avatar) {
            throw new Error("Expected user avatar fixture");
          }
          const avatarStyle = getComputedStyle(avatar);
          const result = {
            borderWidth: avatarStyle.borderTopWidth,
            neutralOutline,
            outline: avatarStyle.outline,
            outlineOffset: avatarStyle.outlineOffset,
          };
          probe.remove();
          return result;
        }, theme);
        expect(edge.outline).toBe(edge.neutralOutline);
        expect(edge.borderWidth).toBe("0px");
        expect(edge.outlineOffset).toBe("-1px");
      }
    });
  });

  it("hides image avatars when the mobile transcript drops their grid column", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread">
            <div class="chat-group assistant chat-group--with-footer">
              <img class="chat-avatar assistant" alt="Assistant" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'/%3E" />
              <div class="chat-group-messages">
                <div class="chat-bubble"><div class="chat-text">Completed work remains readable.</div></div>
              </div>
              <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
            </div>
          </div>
        </body></html>`,
      );
      const avatar = page.locator(".chat-avatar");
      for (const width of [430, 400, 390, 320, 401, 768, 769, 1366]) {
        await page.setViewportSize({ width, height: 720 });
        if (width <= 768) {
          await expectBrowser(avatar).toBeHidden();
        } else {
          await expectBrowser(avatar).toBeVisible();
          const image = await avatar.boundingBox();
          const text = await page.locator(".chat-text").boundingBox();
          expect(image!.x + image!.width).toBeLessThanOrEqual(text!.x);
        }
      }
    });
  });

  it("paints a visible outline when a chat image action receives keyboard focus", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<style>${readUiCss()}</style>
        <button class="chat-tool-card__preview-image-button">Open image</button>`);
      await page.keyboard.press("Tab");
      const button = page.locator("button");
      await expectBrowser(button).toBeFocused();
      await expectBrowser(button).toHaveCSS("outline-style", "solid");
      await expectBrowser(button).toHaveCSS("outline-width", "2px");
    });
  });

  it("applies configured chat width to tool rows and composer without changing defaults", async () => {
    const page = await openBrowserPage(1600, 900);
    const renderFixture = async (configured: boolean) => {
      const style = configured
        ? 'style="--chat-thread-max-width: 82%; --chat-message-max-width: 100%"'
        : "";
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat" ${style}>
          <div class="chat-thread chat-thread--direct" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group tool">
                <div class="chat-group-messages" data-tool-lane>
                  <div class="chat-bubble chat-bubble--tool-shell" data-tool-shell>
                    <div class="chat-tool-msg-collapse">Tool output</div>
                  </div>
                </div>
              </div>
              <div class="chat-group tool chat-group--activity">
                <div class="chat-group-messages" data-activity-lane>
                  <div class="chat-activity-group">Activity</div>
                </div>
              </div>
              <div class="chat-group assistant chat-group--with-footer">
                <div class="chat-group-messages" data-frame-lane>
                  <div class="chat-activity-group">Framed activity</div>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-footer">
            <div class="agent-chat__composer-shell" data-composer>
              <div class="chat-footer__context">
                <div class="chat-prs" data-chat-prs>Pull requests</div>
              </div>
              <div class="agent-chat__input">Composer</div>
            </div>
          </div>
        </section>
      </body></html>`);
      return await page.evaluate(() => {
        const rect = (selector: string) => {
          const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { center: bounds.x + bounds.width / 2, width: bounds.width };
        };
        return {
          activity: rect("[data-activity-lane] .chat-activity-group"),
          composer: rect("[data-composer]"),
          prs: rect("[data-chat-prs]"),
          shell: rect("[data-tool-shell]"),
          framedActivity: rect("[data-frame-lane] .chat-activity-group"),
          thread: rect(".chat-thread-inner"),
          tool: rect("[data-tool-lane]"),
        };
      });
    };

    try {
      const defaults = await renderFixture(false);
      expect(defaults.thread.width).toBeCloseTo(768, 0);
      expect(defaults.composer.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.prs.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.tool.width).toBeCloseTo(defaults.thread.width, 0);
      expect(defaults.shell.width).toBeCloseTo(760, 0);
      expect(defaults.activity.width).toBeCloseTo(760, 0);
      expect(defaults.framedActivity.width).toBeCloseTo(defaults.activity.width, 0);

      const configured = await renderFixture(true);
      for (const key of ["activity", "framedActivity", "shell", "tool"] as const) {
        expect(configured[key].width).toBeCloseTo(configured.thread.width, 0);
      }
      expect(configured.composer.width).toBeCloseTo(configured.prs.width, 0);
      for (const rect of Object.values(configured)) {
        expect(rect.center).toBeCloseTo(configured.thread.center, 0);
      }
      expect(configured.thread.width).toBeGreaterThan(defaults.thread.width);
      expect(configured.composer.width).toBeGreaterThan(defaults.composer.width);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps the desktop model picker label-to-chevron gap at 4px", async () => {
    await withBrowserPage(openBrowserPage(800, 800), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="agent-chat__composer-shell">
          <div class="agent-chat__input">
            <div class="chat-controls__model-settings">
              <div class="chat-controls__inline-select">
                <div class="chat-controls__inline-select-trigger chat-controls__model-trigger">
                  <span class="chat-controls__inline-select-label">Model</span>
                  <span class="chat-controls__inline-select-chevron">${iconSvg()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body></html>`);
      const [label, chevron] = await Promise.all([
        readControl(page, ".chat-controls__inline-select-label"),
        readControl(page, ".chat-controls__inline-select-chevron"),
      ]);
      const measuredGap = chevron.x - label.x - label.width;
      expect(measuredGap).toBeCloseTo(4, 0);
    });
  });

  it("keeps inline MCP App reloads transparent without changing dashboard surfaces", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      const provider = await mountMcpAppSurfaceFixture(page, realChatServer.baseUrl);
      const backgrounds = await provider.evaluate(async (owner: HTMLElement) => {
        await customElements.whenDefined("mcp-app-view");
        const readFrameBackground = async (boardSurface?: string) => {
          if (boardSurface) {
            owner.style.setProperty("--board-surface", boardSurface);
          } else {
            owner.style.removeProperty("--board-surface");
          }
          const view = document.createElement("mcp-app-view") as HTMLElement & {
            updateComplete: Promise<boolean>;
          };
          owner.replaceChildren(view);
          await view.updateComplete;
          const mount = view.querySelector(".mount");
          if (!mount) {
            throw new Error("MCP App mount is missing");
          }
          const frame = document.createElement("iframe");
          mount.append(frame);
          return getComputedStyle(frame).backgroundColor;
        };
        return {
          dashboard: await readFrameBackground("rgb(12, 34, 56)"),
          inline: await readFrameBackground(),
        };
      });

      expect(backgrounds.dashboard).toBe("rgb(12, 34, 56)");
      expect(backgrounds.inline).toBe("rgba(0, 0, 0, 0)");
    });
  });

  it("keeps wrapped message footers inside measured virtual rows", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 220px; height: 400px;">
            <div class="chat-thread-inner chat-thread-inner--virtual" style="width: 220px;">
              <div class="chat-virtual-sizer" style="height: 400px;">
                <div class="chat-virtual-block">
                  <div class="chat-virtual-row" data-first-row >
                    <div
                      class="chat-group assistant chat-group--with-footer"
                      style="--chat-message-max-width: 120px;"
                    >
                      <div class="chat-avatar assistant">A</div>
                      <div class="chat-group-messages">
                        <div class="chat-bubble"><div class="chat-text">A narrow assistant message.</div></div>
                      </div>
                      <div class="chat-group-footer">
                        <div class="chat-group-footer__meta">
                          <span class="chat-sender-name">Assistant</span>
                          <span class="chat-group-timestamp">9:41 PM</span>
                        </div>
                        <div class="chat-group-footer-actions">
                          <button type="button">${iconSvg()}</button>
                          <button type="button">${iconSvg()}</button>
                          <button type="button">${iconSvg()}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="chat-virtual-row" data-second-row>
                    <div class="chat-group user"><div class="chat-group-messages">Next row</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );
      await waitForLayoutSettled(page, "[data-first-row], .chat-group-footer");

      const [first, second, avatar, bubble, footer] = await Promise.all([
        readControl(page, "[data-first-row]"),
        readControl(page, "[data-second-row]"),
        readControl(page, "[data-first-row] .chat-avatar"),
        readControl(page, "[data-first-row] .chat-bubble"),
        readControl(page, "[data-first-row] .chat-group-footer"),
      ]);
      expect(footer.height).toBeGreaterThan(24);
      expect(avatar.top - bubble.top).toBeCloseTo(0, 0);
      expect(footer.bottom).toBeLessThanOrEqual(first.bottom + 1);
      expect(Math.abs(second.top - first.bottom)).toBeLessThanOrEqual(1);
    });
  });

  it("keeps attributed user avatar fallbacks beside the message after identity resolution", async () => {
    await withBrowserPage(openBrowserPage(860, 900), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 768px;">
            <div class="chat-thread-inner" style="width: 768px;">
              <div class="chat-group user chat-group--with-footer">
                <span class="chat-avatar-slot">
                  <img
                    class="chat-avatar user"
                    alt="Collin Johnson"
                    src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='purple'/%3E%3C/svg%3E"
                  />
                  <div class="chat-avatar user chat-avatar--sender-initials">C</div>
                </span>
                <div class="chat-group-messages"><div class="chat-bubble"><div class="chat-text">A newly sent message.</div></div></div>
                <div class="chat-group-footer"><div class="chat-group-footer__meta">
                    <span class="chat-sender-name">collinjohnsonw</span>
                    <span class="chat-group-timestamp">now</span>
                  </div></div>
              </div>
            </div>
          </div>
        </body></html>`,
      );
      const messageAvatarSlot = page.locator(".chat-group .chat-avatar-slot");
      await messageAvatarSlot.locator("img").waitFor();

      const readLayout = () =>
        Promise.all([
          readControl(page, ".chat-group.user"),
          readControl(page, ".chat-group.user .chat-bubble"),
          readControl(page, ".chat-group.user .chat-avatar:visible"),
        ]);

      const imageLayout = await readLayout();
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "grid",
      );
      await messageAvatarSlot.evaluate((slot) => slot.classList.add("is-fallback"));
      const fallbackLayout = await readLayout();

      for (const [group, bubble, avatar] of [imageLayout, fallbackLayout]) {
        expect(avatar.x).toBeGreaterThanOrEqual(bubble.x + bubble.width + 9);
        expect(avatar.x + avatar.width).toBeLessThanOrEqual(group.x + group.width + 1);
      }

      await page
        .locator(".chat-thread")
        .evaluate((thread) => thread.classList.add("chat-thread--direct"));
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "none",
      );
      await page
        .locator(".chat-thread")
        .evaluate((thread) => thread.classList.remove("chat-thread--direct"));
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "none",
      );
    });
  });

  it.each([
    ["dark", false],
    ["light", true],
  ])(
    "keeps a sent gallery above its text bubble without hover changes in %s mode (sender tint: %s)",
    async (theme, tinted) => {
      await withBrowserPage(openBrowserPage(1280, 900), async (page) => {
        const tile = (index: number) => `
        <span class="chat-image-frame" data-tile="${index}">
          <button class="chat-message-image-button" type="button">
            <img class="chat-message-image" width="640" height="640" alt="Image ${index}"
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%23865cff'/%3E%3C/svg%3E" />
          </button>
        </span>`;
        await page.setContent(
          `<!doctype html><html data-theme-mode="${theme}"><head><style>${readUiCss()}</style></head><body>
          <div class="chat-group user ${tinted ? "chat-group--sender-tint" : ""}"
            style="--chat-sender-hue: 208">
            <div class="chat-bubble chat-bubble--with-images">
              <div
                class="chat-message-images chat-message-images--gallery chat-message-images--five"
              >
                ${Array.from({ length: 5 }, (_, index) => tile(index + 1)).join("")}
              </div>
              <div class="chat-text">oi</div>
            </div>
          </div>
        </body></html>`,
        );
        await page.locator(".chat-message-image").first().waitFor();
        const geometry = await page.locator(".chat-bubble").evaluate((bubble) => {
          const gallery = bubble.querySelector<HTMLElement>(".chat-message-images")!;
          const text = bubble.querySelector<HTMLElement>(".chat-text")!;
          const frames = [...gallery.querySelectorAll<HTMLElement>(".chat-image-frame")];
          const boxes = frames.map((frame) => frame.getBoundingClientRect());
          const galleryBox = gallery.getBoundingClientRect();
          const textBox = text.getBoundingClientRect();
          return {
            background: getComputedStyle(bubble).backgroundColor,
            firstRow: boxes.filter((box) => Math.round(box.top) === Math.round(boxes[0]!.top))
              .length,
            fourthAlignedWithSecond: Math.abs(boxes[3]!.left - boxes[1]!.left) <= 1,
            lastRowRightAligned: Math.abs(boxes[4]!.right - galleryBox.right) <= 1,
            textGap: textBox.top - galleryBox.bottom,
            textRightAligned: Math.abs(textBox.right - galleryBox.right) <= 1,
            tileSize: boxes[0]!.width,
          };
        });
        expect(geometry).toMatchObject({
          background: "rgba(0, 0, 0, 0)",
          firstRow: 3,
          fourthAlignedWithSecond: true,
          lastRowRightAligned: true,
          textGap: 8,
          textRightAligned: true,
        });
        expect(geometry.tileSize).toBeCloseTo(128, 0);
        for (const hovered of [true, false]) {
          if (hovered) {
            await page.locator(".chat-message-image").first().hover();
          } else {
            await page.mouse.move(0, 0);
          }
          expect(
            await page.locator(".chat-bubble").evaluate((bubble) => ({
              background: getComputedStyle(bubble).backgroundColor,
              shadow: getComputedStyle(bubble).boxShadow,
            })),
          ).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none" });
        }
      });
    },
  );

  it.each([false, true])(
    "keeps every sent-image text shape on the user bubble surface (sender tint: %s)",
    async (tinted) => {
      await withBrowserPage(openBrowserPage(1280, 900), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-group user ${tinted ? "chat-group--sender-tint" : ""}"
            style="--chat-sender-hue: 208">
            <div class="chat-bubble" data-reference>Text-only message</div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-text" data-shape="text">Short text</div>
            </div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-message-disclosure" data-shape="disclosure">
                <div class="chat-message-disclosure__content">
                  <div class="chat-text">Collapsed text</div>
                </div>
              </div>
            </div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-text" data-shape="json">
                <pre><code class="language-json">{"ready":true}</code></pre>
              </div>
            </div>
          </div>
        </body></html>`,
        );
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate(
            (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
            theme,
          );
          const surfaces = await page.locator("[data-shape]").evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element);
              return {
                backgroundColor: style.backgroundColor,
                color: style.color,
                padding: style.padding,
              };
            }),
          );
          const reference = await page.locator("[data-reference]").evaluate((bubble) => ({
            backgroundColor: getComputedStyle(bubble).backgroundColor,
            color: getComputedStyle(bubble).color,
          }));
          expect(surfaces[0]).toEqual({ ...reference, padding: "10px 14px" });
          expect(surfaces[1]).toEqual(surfaces[0]);
          expect(surfaces[2]).toEqual(surfaces[0]);
          expect(
            await page
              .locator(".chat-bubble--with-images")
              .evaluateAll((bubbles) =>
                bubbles.every(
                  (bubble) => getComputedStyle(bubble).backgroundColor === "rgba(0, 0, 0, 0)",
                ),
              ),
          ).toBe(true);
        }
      });
    },
  );

  it("wraps long question and approval metadata inside narrow cards", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      const longToken = `workspace${"x".repeat(240)}session`;
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div data-narrow-card style="width: 220px;">
            <div class="chat-question-panel__heading">
              <span class="chat-question-panel__progress">1/1</span>
              <span class="chat-question-panel__prompt">${longToken}</span>
            </div>
            <div class="exec-approval-meta">
              <div class="exec-approval-meta-row"><span>Session</span><span>${longToken}</span></div>
            </div>
          </div>
        </body></html>`,
      );

      const metrics = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("[data-narrow-card]")!;
        const heading = document.querySelector<HTMLElement>(".chat-question-panel__heading")!;
        const row = document.querySelector<HTMLElement>(".exec-approval-meta-row")!;
        return {
          cardRight: card.getBoundingClientRect().right,
          headingRight: heading.getBoundingClientRect().right,
          promptRight: document
            .querySelector<HTMLElement>(".chat-question-panel__prompt")!
            .getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
          valueRight: row.lastElementChild!.getBoundingClientRect().right,
        };
      });

      expect(metrics.promptRight).toBeLessThanOrEqual(metrics.headingRight + 1);
      expect(metrics.valueRight).toBeLessThanOrEqual(metrics.rowRight + 1);
      expect(metrics.headingRight).toBeLessThanOrEqual(metrics.cardRight + 1);
      expect(metrics.rowRight).toBeLessThanOrEqual(metrics.cardRight + 1);
    });
  });

  it("reserves command text space for flush tool-card actions", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-tool-card chat-tool-card--flush" style="width: 220px;">
            <div class="chat-tool-card__actions">
              <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
            </div>
            <div class="chat-tool-term">
              <div class="chat-tool-term__cmd"><span class="chat-tool-term__prompt">$</span><code>command with a long first line</code></div>
            </div>
          </div>
        </body></html>`,
      );

      const layout = await page.evaluate(() => {
        const command = document.querySelector<HTMLElement>(".chat-tool-term__cmd")!;
        const actions = document.querySelector<HTMLElement>(".chat-tool-card__actions")!;
        const commandRect = command.getBoundingClientRect();
        return {
          actionLeft: actions.getBoundingClientRect().left,
          commandContentRight:
            commandRect.right - Number.parseFloat(getComputedStyle(command).paddingRight),
        };
      });

      expect(layout.commandContentRight).toBeLessThanOrEqual(layout.actionLeft + 1);
    });
  });

  it("keeps tool-card header actions visible without hover", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-tool-card">
            <div class="chat-tool-card__header">
              <span>ui/src/styles/chat/tool-cards.css</span>
              <div class="chat-tool-card__actions">
                <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      expect(
        await page
          .locator(".chat-tool-card__header > .chat-tool-card__actions")
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toBe("1");
    });
  });

  it.each([
    [320, 568],
    [900, 500],
    [1366, 900],
    [1440, 1400],
  ] as const)(
    "keeps transcript roles, insets, and composer surfaces aligned at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height), async (page) => {
        const spacing = await page.evaluate(() => {
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const firstMessage = document.querySelector<HTMLElement>(
            ".chat-thread-inner > .chat-group",
          );
          if (!thread || !firstMessage) {
            return null;
          }
          return {
            inset: firstMessage.getBoundingClientRect().top - thread.getBoundingClientRect().top,
            paddingTop: Number.parseFloat(getComputedStyle(thread).paddingTop),
          };
        });

        expect(spacing).not.toBeNull();
        expect(spacing?.paddingTop).toBeGreaterThanOrEqual(20);
        expect(spacing?.inset).toBeCloseTo(spacing?.paddingTop ?? 0, 0);
        if (height > 500) {
          const [
            assistantLane,
            assistantBubble,
            transcript,
            transcriptViewport,
            userLane,
            userBubble,
          ] = await Promise.all([
            readControl(page, ".chat-group.assistant .chat-group-messages"),
            readControl(page, ".chat-group.assistant .chat-bubble:first-child"),
            readControl(page, ".chat-thread-inner"),
            readControl(page, ".chat-thread"),
            readControl(page, ".chat-group.user .chat-group-messages"),
            readControl(page, ".chat-group.user .chat-bubble:first-child"),
          ]);

          expect(
            Math.abs(
              transcript.x +
                transcript.width / 2 -
                (transcriptViewport.x + transcriptViewport.width / 2),
            ),
          ).toBeLessThanOrEqual(1);
          if (width <= 768) {
            const composer = await readControl(page, ".agent-chat__composer-shell");
            expect(transcript.x).toBeCloseTo(composer.x, 0);
            expect(transcript.width).toBeCloseTo(composer.width, 0);
          } else {
            expect(transcript.width).toBeCloseTo(768, 0);
          }
          expect(Math.abs(assistantBubble.x - assistantLane.x)).toBeLessThanOrEqual(1);
          expect(
            Math.abs(userBubble.x + userBubble.width - (userLane.x + userLane.width)),
          ).toBeLessThanOrEqual(1);
          expect(userLane.x).toBeGreaterThan(assistantLane.x);
          expect(userBubble.width).toBeLessThan(userLane.width);
          expect(assistantBubble.width).toBeLessThan(assistantLane.width);
        }

        const [code, user, assistant, composerRadius, editorPadding, footerPadding] =
          await Promise.all([
            readStyles(page, ".code-block-wrapper", "border-top-left-radius corner-shape"),
            readStyles(
              page,
              ".chat-group.user .chat-bubble:first-child",
              "border-top-left-radius corner-shape padding-top padding-right padding-bottom padding-left",
            ),
            readStyles(
              page,
              ".chat-group.assistant .chat-bubble:first-child",
              "padding-left padding-right",
            ),
            readStyles(
              page,
              ".agent-chat__composer-shell > .agent-chat__input",
              "border-top-left-radius",
            ),
            readStyles(
              page,
              ".agent-chat__composer-combobox > textarea",
              "padding-top padding-bottom padding-left padding-right",
            ),
            readStyles(page, ".agent-chat__composer-footer", "padding-left padding-right"),
          ]);
        expect(Number.parseFloat(code[0]!)).toBeGreaterThan(0);
        expect(user).toEqual([...code, "16px", "16px", "16px", "16px"]);
        expect(assistant).toEqual(["0px", "0px"]);
        expect(Number.parseFloat(composerRadius[0]!)).toBe(20 * (await readCornerScale(page)));
        const [paddingTop, paddingBottom, paddingLeft, paddingRight] = editorPadding.map(
          Number.parseFloat,
        );
        expect(paddingTop).toBeGreaterThan(0);
        expect(paddingBottom).toBe(paddingTop);
        expect(paddingLeft).toBeGreaterThan(0);
        expect(Number.parseFloat(footerPadding[0]!)).toBeGreaterThan(0);
        expect(footerPadding[1]).toBe(footerPadding[0]);

        const [surface, editor, actionRow] = await Promise.all([
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".agent-chat__composer-combobox > textarea"),
          readControl(page, ".agent-chat__composer-footer"),
        ]);
        expect(surface.height).toBeGreaterThanOrEqual(editor.height + actionRow.height);
        expect(editor.x + paddingLeft!).toBeGreaterThan(surface.x);
        expect(editor.x + editor.width - paddingRight!).toBeLessThan(surface.x + surface.width);
        expect(actionRow.top).toBeGreaterThanOrEqual(editor.bottom - 1);
        expect(surface.bottom - actionRow.bottom).toBeGreaterThanOrEqual(0);
      });
    },
  );

  it.each([[1366, 900]] as const)(
    "centers overflowing direct messages on the composer axis at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height, { direct: true }), async (page) => {
        await page.evaluate(() => {
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const inner = document.querySelector<HTMLElement>(".chat-thread-inner");
          if (!thread || !inner) {
            throw new Error("Missing chat overflow fixture");
          }
          inner.style.minHeight = `${thread.clientHeight + 1}px`;
        });
        await expectNoHorizontalOverflow(page);
        const [assistantLane, composer, thread, userLane, overflow] = await Promise.all([
          getRect(page, ".chat-group.assistant .chat-group-messages"),
          getRect(page, ".agent-chat__composer-shell"),
          getRect(page, ".chat-thread-inner"),
          getRect(page, ".chat-group.user .chat-group-messages"),
          page.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".chat-thread");
            if (!node) {
              return null;
            }
            return {
              clientHeight: node.clientHeight,
              gutter: getComputedStyle(node).scrollbarGutter,
              scrollHeight: node.scrollHeight,
            };
          }),
        ]);

        expect(overflow).not.toBeNull();
        expect(overflow?.scrollHeight).toBeGreaterThan(overflow?.clientHeight ?? 0);
        expect(overflow?.gutter).toBe("stable both-edges");
        const threadCenter = thread.left + thread.width / 2;
        const composerCenter = composer.left + composer.width / 2;
        expect(Math.abs(threadCenter - composerCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(thread.width - composer.width)).toBeLessThanOrEqual(1);
        expect(thread.width).toBeCloseTo(768, 0);
        expect(Math.abs(assistantLane.left - thread.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(userLane.right - thread.right)).toBeLessThanOrEqual(1);
      });
    },
  );

  it.each([
    [320, 568, "dark"],
    [1366, 900, "light"],
  ] as const)(
    "wraps inline code without clipping or detached punctuation at %sx%s in %s",
    async (width, height, themeMode) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group assistant">
                <div class="chat-avatar assistant">A</div>
                <div class="chat-group-messages">
                  <div class="chat-bubble">
                    <div class="chat-text">
                      <p><code data-long-code>openclaw_message_send_channel_webchat_target_example_com_thread_very_long_identifier_without_spaces_1234567890abcdefghijklmnopqrstuvwxyz</code></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-text" data-inline-punctuation><p>Use <code>status</code>; then <code>restart</code>.</p></div>
        </body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const bubble = await getRect(page, ".chat-bubble");
        const inlineCode = await getRect(page, "[data-long-code]");
        expect(inlineCode.right).toBeLessThanOrEqual(bubble.right + 1);
        const spacing = await page.locator("[data-inline-punctuation] code").evaluateAll((nodes) =>
          nodes.map((node) => {
            const punctuation = node.nextSibling;
            if (!(punctuation instanceof Text)) {
              throw new Error("Expected punctuation text after inline code");
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            const textRect = range.getBoundingClientRect();
            range.setStart(punctuation, 0);
            range.setEnd(punctuation, 1);
            const punctuationRect = range.getBoundingClientRect();
            range.detach();
            const chipRect = (node as HTMLElement).getBoundingClientRect();
            const paragraph = (node as HTMLElement).parentElement;
            if (!paragraph) {
              throw new Error("Expected inline code inside a paragraph");
            }
            return {
              horizontalGap: punctuationRect.left - textRect.right,
              chipHeight: chipRect.height,
              lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
            };
          }),
        );

        expect(spacing).toHaveLength(2);
        for (const { horizontalGap, chipHeight, lineHeight } of spacing) {
          // The gap is the chip's em-derived inset plus its border, so a quarter of
          // the 14px prose size holds on every platform.
          expect(horizontalGap).toBeLessThanOrEqual(3.75);
          // Measure the chip against the paragraph's CSS line box rather than a text
          // rect: the chip's content height follows the monospace font's default line
          // spacing, which differs by several px between macOS and Linux.
          expect(lineHeight).toBeGreaterThan(0);
          expect(chipHeight).toBeLessThanOrEqual(lineHeight + 1);
        }
      });
    },
  );

  it.each(["dark", "light"] as const)(
    "fits short table cards to their columns in %s mode",
    async (themeMode) => {
      await withBrowserPage(openBrowserPage(800, 400), async (page) => {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text">
              <div data-table-lane style="width: 680px">
                <table data-short-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
              <div data-narrow-table-lane style="width: 160px">
                <table data-narrow-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
            </div>
          </body></html>`,
        );

        const [lane, narrowLane, narrowTable, table, lastCell] = await Promise.all([
          readControl(page, "[data-table-lane]"),
          readControl(page, "[data-narrow-table-lane]"),
          readControl(page, "[data-narrow-table]"),
          readControl(page, "[data-short-table]"),
          readControl(page, "[data-short-table] tbody td:last-child"),
        ]);
        expect(table.width).toBeLessThan(lane.width);
        expect(table.x + table.width - lastCell.x - lastCell.width).toBeLessThanOrEqual(1);
        expect(narrowTable.width).toBeCloseTo(narrowLane.width, 0);
      });
    },
  );

  it("shows the current effort beside its heading in the accent color", async () => {
    await withBrowserPage(openBrowserPage(393, 852), async (page) => {
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <div class="chat-controls__reasoning-panel">
              <div class="chat-controls__reasoning-head">
                <span class="chat-controls__effort-heading">Effort</span>
                <span class="chat-controls__effort-value">Extra high</span>
              </div>
            </div>
            <span data-accent-probe style="color: var(--accent)"></span>
          </body>
        </html>
      `);

      const [heading, value] = await Promise.all([
        readControl(page, ".chat-controls__effort-heading"),
        readControl(page, ".chat-controls__effort-value"),
      ]);
      expect(value.x).toBeGreaterThanOrEqual(heading.x + heading.width);
      expect(
        Math.abs(value.y + value.height / 2 - heading.y - heading.height / 2),
      ).toBeLessThanOrEqual(1);
      expect(await readStyles(page, ".chat-controls__effort-value", "color")).toEqual(
        await readStyles(page, "[data-accent-probe]", "color"),
      );
    });
  });

  it("keeps the expanded mobile composer inset, scrollable, and flush with the thread", async () => {
    await withBrowserPage(openFixture(393, 852), async (page) => {
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      // Comfortably past a quarter of the tallest viewport this case runs at,
      // so the assertion below proves the cap and the scroll, not the draft.
      await textarea.fill(
        Array.from({ length: 16 }, (_value, index) => `Mobile composer line ${index + 1}`).join(
          "\n",
        ),
      );
      await textarea.evaluate((node) => {
        const textareaNode = node as HTMLTextAreaElement;
        textareaNode.style.height = `${textareaNode.scrollHeight}px`;
      });
      await page.locator(".context-ring").evaluate(finishElementAnimations);

      const [shell, input, thread, meta, model, context, send, attach, attachIcon, textareaRect] =
        await Promise.all([
          readControl(page, ".agent-chat__composer-shell"),
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".chat-thread"),
          readControl(page, ".agent-chat__composer-meta"),
          readControl(page, ".chat-composer-model-control"),
          readControl(page, ".context-ring"),
          readControl(page, ".chat-send-btn"),
          readControl(page, '.agent-chat__input-btn[aria-label="Add attachment"]'),
          readControl(page, '.agent-chat__input-btn[aria-label="Add attachment"] svg'),
          readControl(page, ".agent-chat__composer-combobox > textarea"),
        ]);
      const viewport = page.viewportSize()!;

      expect(textareaRect.height).toBeLessThanOrEqual(viewport.height * 0.25 + 1);
      expect(textareaRect.scrollHeight).toBeGreaterThan(textareaRect.clientHeight);
      expect(input.y - (thread.y + thread.height)).toBeCloseTo(0, 0);
      expect(shell.x).toBeCloseTo(20, 0);
      expect(viewport.width - (shell.x + shell.width)).toBeCloseTo(shell.x, 0);
      expect(attach.x - input.x).toBeLessThanOrEqual(10);
      expect(model.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
      expect(input.x + input.width - (send.x + send.width)).toBeCloseTo(attach.x - input.x, 0);
      for (const control of [model, context]) {
        expect(
          Math.abs(control.y + control.height / 2 - (model.y + model.height / 2)),
        ).toBeLessThanOrEqual(2);
      }
      expect(meta.y).toBeGreaterThanOrEqual(model.y - 1);
      expect(attachIcon.width).toBeGreaterThanOrEqual(16);
      expect(attachIcon.height).toBeGreaterThanOrEqual(16);
    });
  });

  it("keeps transient footer controls from crushing mobile model settings", async () => {
    await withBrowserPage(openFixture(320, 568, { crowdedComposerFooter: true }), async (page) => {
      await expectNoHorizontalOverflow(page);
      const [controls, footer, meta, settings, typing] = await Promise.all([
        readControl(page, ".agent-chat__composer-controls"),
        readControl(page, ".agent-chat__composer-footer"),
        readControl(page, ".agent-chat__composer-meta"),
        readControl(page, ".chat-controls__model-trigger"),
        readControl(page, ".agent-chat__typing-indicator--outside"),
      ]);
      expect(page.viewportSize()).toEqual({ width: 320, height: 568 });
      expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth + 1);
      expect(settings.x).toBeGreaterThanOrEqual(footer.x - 1);
      expect(settings.x + settings.width).toBeLessThanOrEqual(footer.x + footer.width + 1);
      expect(typing.x).toBeGreaterThanOrEqual(0);
      expect(typing.x + typing.width).toBeLessThanOrEqual(320);
      expect(settings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(settings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(rectsOverlap(settings, meta)).toBe(false);
      expect(rectsOverlap(typing, footer)).toBe(false);
    });
  });

  it.each([
    [320, 568],
    [430, 932],
    [768, 1024],
    [1024, 768],
    [568, 320],
    [1920, 1080],
  ] as const)(
    "keeps the composer bottom controls, attachment, and primary action aligned at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height), async (page) => {
        await expectNoHorizontalOverflow(page);
        const code = await getBoundingBox(page, ".chat-text pre");
        expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
        // Wall-clock sleeps can expire before Chromium advances compositor animations
        // on a contended CI runner. Measure the footer after its finite entrance effect.
        await page.locator(".context-ring").evaluate(finishElementAnimations);
        const [
          chat,
          shell,
          input,
          thread,
          footer,
          textarea,
          meta,
          model,
          context,
          attach,
          send,
          modelTrigger,
          modelLabel,
          effortTrigger,
          effortLabel,
        ] = await Promise.all([
          readControl(page, ".chat"),
          readControl(page, ".agent-chat__composer-shell"),
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".chat-thread"),
          readControl(page, ".agent-chat__composer-footer"),
          readControl(page, ".agent-chat__composer-combobox > textarea"),
          readControl(page, ".agent-chat__composer-meta"),
          readControl(page, ".chat-composer-model-control"),
          readControl(page, ".context-ring"),
          readControl(page, '.agent-chat__input-btn[aria-label="Add attachment"]'),
          readControl(page, ".chat-send-btn"),
          readControl(page, ".chat-controls__model-trigger"),
          readControl(page, ".chat-controls__model-trigger .chat-controls__inline-select-label"),
          readControl(page, ".chat-controls__effort-trigger"),
          readControl(page, ".chat-controls__effort-trigger .chat-controls__inline-select-label"),
        ]);

        for (const control of [footer, textarea, meta, model, context, attach, send]) {
          expect(control.x).toBeGreaterThanOrEqual(input.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(input.x + input.width + 1);
        }
        for (const control of [input, send]) {
          expect(control.x).toBeGreaterThanOrEqual(shell.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(shell.x + shell.width + 1);
        }
        expect(model.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(model.y + model.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(model.y).toBeGreaterThanOrEqual(textarea.y);
        expect(context.y).toBeGreaterThanOrEqual(textarea.y);
        expect(attach.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(attach.y + attach.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(send.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(send.y + send.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(attach.y).toBeGreaterThanOrEqual(textarea.y + textarea.height - 1);
        expect(send.y).toBeGreaterThanOrEqual(textarea.y + textarea.height - 1);
        expect(attach.x).toBeLessThan(send.x);
        expect(send.x + send.width).toBeLessThanOrEqual(input.x + input.width + 1);
        expect(rectsOverlap(model, send)).toBe(false);
        const contextModelGap = model.x - (context.x + context.width);
        expect(contextModelGap).toBeGreaterThanOrEqual(-1);
        expect(
          Math.abs(context.y + context.height / 2 - (model.y + model.height / 2)),
        ).toBeLessThanOrEqual(2);
        const composerFontSizes = await page.evaluate(() => {
          const textareaNode = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          const selectors = [
            ".chat-controls__model-trigger .chat-controls__inline-select-label",
            ".chat-controls__effort-trigger .chat-controls__inline-select-label",
          ];
          if (!textareaNode) {
            throw new Error("Missing composer textarea");
          }
          const fontSize = (node: Element, pseudo?: string) =>
            Number.parseFloat(getComputedStyle(node, pseudo).fontSize);
          return {
            labels: selectors.map((selector) => {
              const label = document.querySelector(selector);
              if (!label) {
                throw new Error(`Missing composer label: ${selector}`);
              }
              return fontSize(label);
            }),
            placeholder: fontSize(textareaNode, "::placeholder"),
            textarea: fontSize(textareaNode),
          };
        });
        expect(composerFontSizes).toEqual({
          labels: [13, 13],
          placeholder: 14,
          textarea: 14,
        });
        if (width === 320) {
          expect(attach.width).toBeGreaterThanOrEqual(32);
          expect(attach.height).toBeGreaterThanOrEqual(32);
          await page
            .locator('.agent-chat__input-btn[aria-label="Add attachment"]')
            .click({ trial: true });
        }
        if (width <= 480) {
          const modelSettings = modelTrigger;
          expect(model.width).toBeGreaterThanOrEqual(40);
          expect(model.width).toBeLessThanOrEqual(footer.width);
          expect(modelSettings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(modelSettings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(modelSettings.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
        } else {
          for (const label of [modelLabel, effortLabel]) {
            expect(label.scrollWidth ?? 0).toBeLessThanOrEqual((label.clientWidth ?? 0) + 1);
          }
          expect(modelTrigger.x).toBeGreaterThanOrEqual(model.x - 1);
          expect(effortTrigger.x).toBeGreaterThanOrEqual(modelTrigger.x + modelTrigger.width - 1);
        }
        expect(send.width).toBeGreaterThanOrEqual(32);
        expect(send.height).toBeGreaterThanOrEqual(32);
        expect(
          Math.abs(attach.y + attach.height / 2 - send.y - send.height / 2),
        ).toBeLessThanOrEqual(1);

        if (width >= 1600) {
          expect(shell.width).toBeGreaterThanOrEqual(767);
          expect(shell.width).toBeLessThanOrEqual(769);
          expect(
            Math.abs(shell.x + shell.width / 2 - (chat.x + chat.width / 2)),
          ).toBeLessThanOrEqual(1);
          expect(input.height).toBeLessThanOrEqual(119);
        }

        if (width > height && height <= 500) {
          expect(input.height).toBeLessThanOrEqual(height * 0.38);
          expect(thread.height).toBeGreaterThanOrEqual(height * 0.4 - 1);
          expect(textarea.height).toBeLessThanOrEqual(56.1);
        }
      });
    },
  );

  it.each([
    [320, 568],
    [844, 390],
    [1440, 1000],
  ] as const)(
    "aligns attachment previews with draft text without clipping remove targets at %sx%s",
    async (width, height) => {
      await withBrowserPage(
        openFixture(width, height, { composerAttachment: true }),
        async (page) => {
          await expectNoHorizontalOverflow(page);
          await page.locator(".chat-attachment-remove").focus();
          await page.locator(".chat-attachment-remove").evaluate(finishElementAnimations);
          await page.locator(".agent-chat__input").evaluate((node) => {
            node.scrollTop = 0;
          });
          const { input, preview, attachment, remove, topHits, textStart } = await page.evaluate(
            () => {
              const elementFor = (selector: string) => {
                const [element, ...others] = document.querySelectorAll(selector);
                if (!element || others.length > 0) {
                  throw new Error(`Expected one layout element: ${selector}`);
                }
                return element;
              };
              const rectFor = (selector: string) => {
                const {
                  x,
                  y,
                  width: rectWidth,
                  height: rectHeight,
                } = elementFor(selector).getBoundingClientRect();
                return { x, y, width: rectWidth, height: rectHeight };
              };
              const removeNode = elementFor(".chat-attachment-remove");
              const removeRect = rectFor(".chat-attachment-remove");
              const textarea = elementFor(".agent-chat__composer-combobox > textarea");
              return {
                input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
                preview: rectFor(".chat-attachments-preview"),
                attachment: rectFor(".chat-attachment-thumb"),
                remove: removeRect,
                topHits: [1, 3].map(
                  (offset) =>
                    document.elementFromPoint(
                      removeRect.x + removeRect.width / 2,
                      removeRect.y + offset,
                    ) === removeNode,
                ),
                textStart:
                  textarea.getBoundingClientRect().x +
                  Number.parseFloat(getComputedStyle(textarea).paddingLeft),
              };
            },
          );
          for (const rect of [input, preview, attachment, remove]) {
            expectFiniteRect(rect);
          }

          expect(attachment.x - input.x).toBeGreaterThanOrEqual(9.5);
          expect(Math.abs(attachment.x - textStart)).toBeLessThanOrEqual(0.5);
          expect(preview.x).toBeGreaterThanOrEqual(input.x);
          expect(remove.y).toBeGreaterThanOrEqual(preview.y);
          expect(remove.x + remove.width).toBeLessThanOrEqual(preview.x + preview.width);
          expect(remove.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(remove.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(topHits).toEqual([true, true]);

          await page.locator(".chat-attachments-preview").evaluate((node) => {
            const firstAttachment = node.querySelector(".chat-attachment-thumb")!;
            for (let index = 0; index < 7; index++) {
              node.append(firstAttachment.cloneNode(true));
            }
            node.scrollLeft = node.scrollWidth;
          });
          const lastRemove = page.locator(".chat-attachment-remove").last();
          await lastRemove.focus();
          await lastRemove.evaluate(finishElementAnimations);
          const rightHits = await lastRemove.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return [1, 3].map(
              (offset) =>
                document.elementFromPoint(bounds.right - offset, bounds.y + bounds.height / 2) ===
                node,
            );
          });
          expect(rightHits).toEqual([true, true]);
        },
      );
    },
  );

  it.each([
    { dock: "narrow", width: 620, height: 600 },
    { dock: "bottom", width: 900, height: 300 },
    { dock: "bottom", width: 900, height: 1000 },
  ])(
    "keeps both stacked panels usable at $width×$height ($dock)",
    async ({ dock, width, height }) => {
      await withBrowserPage(openBrowserPage(1000, 1100), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: ${width}px; height: ${height}px; display: flex;">
            <div class="sidebar-region sidebar-region--${dock} sidebar-region--open" style="--side-panel-height: 360px">
              <main class="sidebar-region__primary" data-region="main">Primary chat</main>
              <section class="side-panel">
                <div class="rail-header side-panel__header" data-region-header="side">Details</div>
                <div class="side-panel__body">
                  <div class="side-panel__panel" data-region="side">Active detail panel</div>
                </div>
              </section>
            </div>
          </div>
        </body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const primary = await getRect(page, ".sidebar-region__primary");
        const sidebar = await getRect(page, '[data-region="side"]');
        expect(sidebar.top).toBeGreaterThanOrEqual(primary.bottom - 1);
        expect(Math.abs(sidebar.width - primary.width)).toBeLessThanOrEqual(1);
        expect(sidebar.width).toBeGreaterThanOrEqual(width - 2);
        expect(primary.height).toBeGreaterThan(80);
        expect(sidebar.height).toBeGreaterThan(80);
        expect(sidebar.bottom - primary.top).toBe(height);
        if (dock === "bottom" && height === 1000) {
          expect(sidebar.height).toBe(360);
        }
      });
    },
  );

  it("keeps short-landscape composer adjunct rows scroll-reachable", async () => {
    await withBrowserPage(
      openFixture(568, 320, { composerAttachment: true, goalMode: true }),
      async (page) => {
        await page
          .locator(".agent-chat__composer-combobox > textarea")
          .fill(
            Array.from(
              { length: 10 },
              (_value, index) =>
                `Landscape proof line ${index + 1}: keep transcript visible while this long draft scrolls inside the bounded composer.`,
            ).join("\n"),
          );

        const [input, thread, textarea] = await Promise.all([
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".chat-thread"),
          readControl(page, ".agent-chat__composer-combobox > textarea"),
        ]);
        expect(input.height).toBeLessThanOrEqual(320 * 0.38);
        expect(thread.height).toBeGreaterThanOrEqual(320 * 0.4 - 1);

        expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
        expect(
          await page
            .locator(".agent-chat__input")
            .evaluate((node) => getComputedStyle(node).overflowY),
        ).toBe("auto");
        expect(
          await page.locator(".agent-chat__goal-mode").evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              borderBottomStyle: style.borderBottomStyle,
              borderLeftStyle: style.borderLeftStyle,
              borderRadius: style.borderRadius,
              marginBottom: style.marginBottom,
            };
          }),
        ).toEqual({
          borderBottomStyle: "solid",
          borderLeftStyle: "none",
          borderRadius: "0px",
          marginBottom: "0px",
        });
        expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);

        await page.locator(".agent-chat__composer-shell > .agent-chat__input").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const [scrolledShell, scrolledInput, meta, model, send] = await Promise.all([
          readControl(page, ".agent-chat__composer-shell"),
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".agent-chat__composer-meta"),
          readControl(page, ".chat-composer-model-control"),
          readControl(page, ".chat-send-btn"),
        ]);

        expect(scrolledInput.scrollTop).toBeGreaterThan(0);
        for (const rect of [meta, model]) {
          expect(rect.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
          expect(rect.y + rect.height).toBeLessThanOrEqual(
            scrolledInput.y + scrolledInput.height + 1,
          );
        }
        expect(send.y).toBeGreaterThanOrEqual(scrolledShell.y - 1);
        expect(send.y + send.height).toBeLessThanOrEqual(
          scrolledShell.y + scrolledShell.height + 1,
        );
      },
    );
  });

  it("keeps short-landscape slash menu visible inside the bounded composer", async () => {
    await withBrowserPage(
      openFixture(568, 320, {
        composerAttachment: true,
        slashMenu: true,
      }),
      async (page) => {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("/review");

        const [input, menu, textarea] = await Promise.all([
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".slash-menu"),
          readControl(page, ".agent-chat__composer-combobox > textarea"),
        ]);
        expect(input.height).toBeLessThanOrEqual(320 * 0.38);

        expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
        expect(menu.y).toBeGreaterThanOrEqual(input.y - 1);
        expect(menu.y + menu.height).toBeLessThanOrEqual(input.y + input.height + 1);
        expect(menu.height).toBeGreaterThanOrEqual(48);
        expect(menu.height).toBeLessThanOrEqual(89);
        expect(textarea.y).toBeGreaterThan(menu.y);

        await page.locator(".agent-chat__composer-shell > .agent-chat__input").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const [scrolledInput, footer] = await Promise.all([
          readControl(page, ".agent-chat__composer-shell > .agent-chat__input"),
          readControl(page, ".agent-chat__composer-footer"),
        ]);

        expect(footer.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
        expect(footer.y + footer.height).toBeLessThanOrEqual(
          scrolledInput.y + scrolledInput.height + 1,
        );
      },
    );
  });

  it("keeps mobile slash command copy in separate grid tracks", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="slash-menu" style="position: relative">
          <div class="slash-menu-item" role="option">
            <span class="slash-menu-icon">${iconSvg()}</span>
            <span class="slash-menu-copy">
              <span class="slash-menu-name">/session <span class="slash-menu-args">idle max-age &lt;duration|off&gt;</span></span>
              <span class="slash-menu-desc">Manage session-level settings (for example /session idle).</span>
            </span>
          </div>
        </div>
      </body></html>`);

      const geometry = await page.locator(".slash-menu-copy").evaluate((copy) => {
        const name = copy.querySelector<HTMLElement>(".slash-menu-name")!;
        const description = copy.querySelector<HTMLElement>(".slash-menu-desc")!;
        const nameRect = name.getBoundingClientRect();
        const descriptionRect = description.getBoundingClientRect();
        return {
          copyOverflow: copy.scrollWidth - copy.clientWidth,
          gap: descriptionRect.left - nameRect.right,
        };
      });

      expect(geometry.copyOverflow).toBeLessThanOrEqual(1);
      expect(geometry.gap).toBeGreaterThanOrEqual(8);
    });
  });

  it("keeps a long task panel full-width with a fixed header and an internal body scroll", async () => {
    const page = await openBrowserPage(980, 844);
    const stepCount = 14;
    const steps = Array.from(
      { length: stepCount },
      (
        _,
        index,
      ) => `<li class="session-progress-card__step session-progress-card__step--${index < 5 ? "completed" : index === 5 ? "in_progress" : "pending"}">
        <span class="session-progress-card__step-marker">${iconSvg()}</span>
        <span class="session-progress-card__step-text">Plan step ${index + 1}</span>
      </li>`,
    ).join("");
    try {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}
        body { margin: 0; padding: 32px; background: var(--bg); }
        .agent-chat__composer-shell { width: 760px; margin: 0 auto; }
        .session-progress-card__summary :is(
          .session-progress-card__summary-title,
          .session-progress-card__heading-actions,
          .session-progress-card__current,
          .session-progress-card__summary-count,
          .session-progress-card__summary-chevron
        ) { transition: none; }
      </style></head><body>
        <div class="agent-chat__composer-shell">
          <div class="chat-footer__context">
          <div class="agent-chat__progress-float">
            <details class="session-progress-card session-progress-card--composer" open>
              <summary class="session-progress-card__summary">
                <span class="session-progress-card__summary-indicator">
                  <span class="session-run-spinner"></span>
                </span>
                <span class="session-progress-card__summary-collapsed">
                  <span class="session-progress-card__current">Abrir a interface</span>
                </span>
                <span class="session-progress-card__summary-count session-progress-card__summary-count--collapsed">1/${stepCount}</span>
                <span class="session-progress-card__summary-expanded">
                  <span class="session-progress-card__summary-title">Task progress</span>
                  <span class="session-progress-card__heading-actions">6 of ${stepCount}</span>
                </span>
                <span class="session-progress-card__summary-chevron">${iconSvg()}</span>
              </summary>
              <div class="session-progress-card__body"><ol class="session-progress-card__steps">${steps}</ol></div>
            </details>
          </div>
          <div class="chat-queue">
            <div class="chat-queue__scroll">
              <div class="chat-queue__item chat-queue__item--no-avatar">
                <span class="chat-queue__leading">${iconSvg()}</span>
                <span class="chat-queue__copy"><span class="chat-queue__text">Queued after the plan</span></span>
                <span class="chat-queue__actions"><button class="chat-queue__remove">${iconSvg()}</button></span>
              </div>
            </div>
          </div>
          <div class="agent-chat__goal-float">
            <div class="agent-chat__goal agent-chat__goal--active" data-expanded="false">
              <div class="agent-chat__goal-row">
                <span class="agent-chat__goal-icon">${iconSvg()}</span>
                <span class="agent-chat__goal-copy">
                  <span class="agent-chat__goal-label">Pursuing goal</span>
                  <span class="agent-chat__goal-objective">Ship the aligned stack</span>
                </span>
                <span class="agent-chat__goal-elapsed">14m</span>
                <span class="agent-chat__goal-actions">
                  <button class="agent-chat__goal-action agent-chat__goal-expand">${iconSvg()}</button>
                </span>
              </div>
            </div>
          </div>
          </div>
          <div class="agent-chat__input">Composer</div>
        </div>
        <span id="failed-outcome-probe" class="session-progress-card__summary-count" data-outcome="failed">Failed</span>
        <span id="danger-color-probe" style="color: var(--danger)">Danger</span>
      </body></html>`);
      await page.evaluate(() => {
        document.documentElement.dataset.themeMode = "light";
      });

      const summary = page.locator(".session-progress-card__summary");
      const card = page.locator(".session-progress-card--composer");
      const body = page.locator(".session-progress-card__body");
      const prefix = ".session-progress-card__";
      const summaryState = () =>
        Promise.all([
          readStyles(page, ".session-progress-card--composer", "background-color"),
          readStyles(page, prefix + "summary", "background-color"),
          ...[
            "summary-title",
            "heading-actions",
            "current",
            "summary-count--collapsed",
            "summary-chevron",
          ].map((part) => readStyles(page, prefix + part, "color")),
          readStyles(
            page,
            prefix + "summary-indicator .session-run-spinner",
            "border-color border-top-color",
          ),
        ]);
      const setSummaryHover = async (hovered: boolean) => {
        if (hovered) {
          await summary.hover();
        } else {
          await page.mouse.move(0, 0);
        }
        const state = await page.waitForFunction(
          (expected) =>
            document.querySelector(".session-progress-card__summary")!.matches(":hover") ===
            expected,
          hovered,
        );
        await state.dispose();
      };
      const expectHover = async (changed: number[], spinnerStable = false) => {
        const before = await summaryState();
        await setSummaryHover(true);
        const after = await summaryState();
        expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
        for (const index of changed) {
          expect(after[index]).not.toEqual(before[index]);
        }
        if (spinnerStable) {
          expect(after[7]).toEqual(before[7]);
        }
      };
      const widthBefore = (await card.boundingBox())?.width;
      const summaryBefore = await readControl(page, prefix + "summary");
      const [title, marker] = await Promise.all([
        readControl(page, prefix + "summary-title"),
        readControl(page, prefix + "step-marker >> nth=0"),
      ]);
      expect(title.x).toBeCloseTo(marker.x, 1);
      const surfaceSelectors = [
        ".session-progress-card--composer",
        ".chat-queue",
        ".agent-chat__goal",
        ".agent-chat__input",
      ];
      const properties =
        "background-color border-color box-shadow border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius";
      const surfaces = await Promise.all(
        surfaceSelectors.map(async (selector) => ({
          rect: await readControl(page, selector),
          css: await readStyles(page, selector, properties),
        })),
      );
      const shell = await readControl(page, ".agent-chat__composer-shell");
      const warnings = [];
      for (const state of ["blocked", "budget_limited", "usage_limited"]) {
        await page.locator(".agent-chat__goal").evaluate((node, value) => {
          node.className = "agent-chat__goal agent-chat__goal--" + value;
        }, state);
        warnings.push(await readStyles(page, ".agent-chat__goal", "background-color border-color"));
      }
      await page.locator(".agent-chat__goal").evaluate((node) => {
        node.className = "agent-chat__goal agent-chat__goal--active";
      });
      await expectHover([2, 3, 6]);
      expect(widthBefore).toBeCloseTo(760, 1);
      expect((await card.boundingBox())?.width).toBeCloseTo(widthBefore ?? 0, 1);
      expect(new Set(surfaces.slice(0, 3).map(({ css }) => css[0])).size).toBe(1);
      for (const [index, { rect, css }] of surfaces.entries()) {
        expect(rect.x).toBeCloseTo(shell.x, 1);
        expect(rect.x + rect.width).toBeCloseTo(shell.x + shell.width, 1);
        expect(Number.parseFloat(css[3]!)).toBeGreaterThan(0);
        expect(css.slice(4)).toEqual([css[3], css[3], css[3]]);
        if (index > 0) {
          expect(rect.top).toBeGreaterThan(surfaces[index - 1]!.rect.bottom);
        }
      }
      expect(surfaces[2]!.css[1]).toBe(surfaces[1]!.css[1]);
      expect(surfaces[2]!.css[2]).toBe(surfaces[1]!.css[2]!.split(", rgba")[0]);
      for (const warning of warnings) {
        expect(warning[0]).not.toBe(surfaces[2]!.css[0]);
        expect(warning[1]).not.toBe(surfaces[2]!.css[1]);
      }
      expect(new Set(warnings.map((warning) => warning[1])).size).toBe(1);

      const bodyLayout = await body.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return {
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          overflowY: getComputedStyle(node).overflowY,
          visibleItems: [...node.querySelectorAll(".session-progress-card__step")].filter(
            (child) => {
              const row = child.getBoundingClientRect();
              return row.bottom <= bounds.bottom + 1 && row.top >= bounds.top - 1;
            },
          ).length,
        };
      });
      expect(bodyLayout.overflowY).toBe("auto");
      expect(bodyLayout.scrollHeight).toBeGreaterThan(bodyLayout.clientHeight);
      expect(bodyLayout.visibleItems).toBeGreaterThan(0);
      expect(bodyLayout.visibleItems).toBeLessThan(stepCount);
      expect(await readStyles(page, prefix + "steps", "overflow-y")).toEqual(["visible"]);
      const companionIcons = ".chat-queue__leading svg, .agent-chat__goal-icon svg";
      const trailingIcons = prefix + "summary-chevron svg, .agent-chat__goal-expand svg";
      expectAligned(await readAxis(page, prefix + "step-marker > *, " + companionIcons, "x", true));
      const textAxis = await readAxis(page, prefix + "step-text >> nth=0", "x");
      expectAligned([
        ...textAxis,
        ...(await readAxis(page, ".chat-queue__copy, .agent-chat__goal-label", "x")),
      ]);
      expectAligned(await readAxis(page, trailingIcons, "x", true));
      await body.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect((await summary.boundingBox())?.y).toBeCloseTo(summaryBefore.y, 1);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await setSummaryHover(false);
      await card.evaluate((node) => node.removeAttribute("open"));
      const collapsedState = await page.waitForFunction(
        () =>
          !document.querySelector(".session-progress-card--composer")!.hasAttribute("open") &&
          getComputedStyle(document.querySelector(".session-progress-card__summary-collapsed")!)
            .display !== "none",
      );
      await collapsedState.dispose();
      await expectHover([4, 5, 6], true);
      const [current, count, chevron] = await Promise.all([
        readControl(page, prefix + "current"),
        readControl(page, prefix + "summary-count--collapsed"),
        readControl(page, prefix + "summary-chevron"),
      ]);
      expect(count.x).toBeGreaterThan(current.x + current.width);
      expect(count.x + count.width).toBeLessThanOrEqual(chevron.x);
      expectAligned(
        await readAxis(page, prefix + "summary-indicator > *, " + companionIcons, "x", true),
      );
      expectAligned(await readAxis(page, trailingIcons, "x", true));
      expectAligned(
        await readAxis(
          page,
          ["summary-indicator > *", "current", "summary-count--collapsed", "summary-chevron > svg"]
            .map((part) => prefix + part)
            .join(", "),
          "y",
          true,
        ),
      );
      await page.locator("#failed-outcome-probe").evaluate(finishElementAnimations);
      expect(await readStyles(page, "#failed-outcome-probe", "color")).toEqual(
        await readStyles(page, "#danger-color-probe", "color"),
      );
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("allows pointer selection in the embedded side-chat transcript", async () => {
    await withBrowserPage(openBrowserPage(1024, 768), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded">
          <div class="chat-session-rail__thread">
            <article class="chat-session-rail__exchange">
              <div class="chat-bubble">
                <span data-selection-target>Copy this side chat answer.</span>
              </div>
            </article>
          </div>
        </section>
      </body></html>`);

      const target = page.locator("[data-selection-target]");
      const box = await target.boundingBox();
      if (!box) {
        throw new Error("Expected side-chat selection target");
      }
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();

      expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(
        "Copy this side chat answer.",
      );
    });
  });

  it.each([
    [320, 568],
    [1024, 768],
  ] as const)(
    "keeps embedded side-chat scrolling, composer, and metadata within its panel at %sx%s",
    async (width, height) => {
      await withBrowserPage(openSessionRailFixture(width, height), async (page) => {
        await expectNoHorizontalOverflow(page);
        const railSelector = ".chat-session-rail";
        const [rail, host, composer, input, footer, send, body] = await Promise.all([
          readControl(page, railSelector),
          readControl(page, ".side-panel__panel"),
          readControl(page, railSelector + "__composer"),
          readControl(page, railSelector + "__input"),
          readControl(page, railSelector + "__composer .agent-chat__composer-footer"),
          readControl(page, railSelector + "__composer .chat-send-btn"),
          readControl(page, railSelector + "__thread"),
        ]);
        expect(await readStyles(page, railSelector, "position")).toEqual(["relative"]);
        expect(rail.clientHeight).toBeLessThanOrEqual(host.clientHeight);
        expect(host.clientHeight).toBeLessThanOrEqual(height);
        expect(body.clientHeight).toBeLessThan(body.scrollHeight);
        const scrollTop = await page.locator(railSelector + "__thread").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop;
        });
        expect(scrollTop).toBeGreaterThan(0);
        expect(composer.bottom).toBeLessThanOrEqual(rail.bottom + 1);
        expect(input.width).toBeGreaterThan(composer.width * 0.8);
        expect(footer.width).toBeGreaterThan(composer.width * 0.8);
        expect(Math.abs(composer.x + composer.width - send.x - send.width)).toBeLessThanOrEqual(10);
        expect(
          await readStyles(page, railSelector + "__thread", "border-top-width margin-top"),
        ).toEqual(["0px", "0px"]);
        const threadStyles = await readStyles(
          page,
          railSelector + "__thread",
          "min-height overflow-y",
        );
        expect(threadStyles).toEqual(["96px", "auto"]);
        // Metadata must not acquire the thread's scrolling-box rule.
        for (const suffix of ["__pr-checks", "__hint"]) {
          const styles = await readStyles(
            page,
            railSelector + suffix,
            "min-height overflow-y border-top-width",
          );
          expect(styles[0]).not.toBe(threadStyles[0]);
          expect(styles.slice(1)).toEqual(["visible", "0px"]);
        }
      });
    },
  );

  it("matches the reading prototype's transcript letter spacing without changing shared text", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      await page.setContent(`<!doctype html><html data-theme-mode="dark"><head><style>${readUiCss()}</style></head><body>
        <div class="chat-thread chat-thread--direct" role="log">
          <div class="chat-thread-inner">
            <div class="chat-group assistant">
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <div class="chat-text">
                    <p>Aa Bb Cc — Smooth reading depends on the shape, spacing, and contrast of every glyph in a transcript.</p>
                    <p>Keep this fixture about text rendering; width and block rhythm are intentionally not asserted here.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <section class="custodian-surface">
          <div class="chat-bubble"><div class="chat-text">Custodian output</div></div>
        </section>
        <div class="chat-notice"><div class="chat-text chat-notice__body">Compact notice</div></div>
        <div class="cron-run-entry__body chat-text">Cron output</div>
      </body></html>`);

      expect(
        await readStyles(page, ".chat-thread .chat-bubble .chat-text", "letter-spacing"),
      ).toEqual(["normal"]);
      const shared = await readStyles(page, "body", "letter-spacing");
      for (const selector of [
        ".custodian-surface .chat-text",
        ".chat-notice .chat-text",
        ".cron-run-entry__body.chat-text",
      ]) {
        expect(await readStyles(page, selector, "letter-spacing")).toEqual(shared);
      }
    });
  });
});
for (const engine of [chromium, webkit]) {
  const executablePath = engine === chromium ? chromiumExecutablePath : engine.executablePath();
  // The normal UI lane provisions Chromium; run the same regression in WebKit
  // when installed so Safari's different intrinsic grid sizing stays covered.
  describe.skipIf(!existsSync(executablePath))(
    `${engine.name()} image alignment`,
    { concurrent: false },
    () => {
      let browser: Browser;
      beforeAll(async () => {
        browser = await engine.launch({ executablePath });
      });
      afterAll(async () => {
        await browser?.close();
      });
      it.each([
        [1440, 1600, 1200],
        [1440, 1800, 420],
        [375, 1800, 420],
      ])(
        "keeps %ipx-wide chat image frames on their visible edges (%i×%i)",
        async (viewportWidth, width, height) => {
          await withBrowserPage(
            browser.newPage({ viewport: { width: viewportWidth, height: 900 } }),
            async (page) => {
              const source = `data:image/svg+xml,${encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
              )}`;
              const prompt = `<div class="chat-text"><p>Review this image.</p><p>Keep paragraph spacing.</p></div>`;
              await page.setContent(`<!doctype html><html style="--chat-text-size: 20px"><head><style>${readUiCss()}</style></head><body>
                <main style="width: 740px; max-width: 100%; margin: auto">
                  ${["user", "user chat-group--peer", "assistant"]
                    .map(
                      (role) => `<div class="chat-group ${role}">
                        <div class="chat-group-messages">
                          <div class="chat-bubble chat-bubble--with-images">
                            <div class="chat-message-images chat-message-images--single">
                              <span class="chat-image-frame"><button class="chat-message-image-button" type="button">
                                <img class="chat-message-image" src="${source}" width="${width}" height="${height}" alt="Large attachment" />
                              </button></span>
                            </div>
                            ${role === "assistant" ? prompt : `<div class="chat-message-avatar-anchor">${prompt}</div>`}
                          </div>
                        </div>
                      </div>`,
                    )
                    .join("")}
                </main></body></html>`);
              await page
                .locator("img")
                .evaluateAll((images: HTMLImageElement[]) =>
                  Promise.all(images.map((image) => image.decode())),
                );
              const rows = await page.locator(".chat-group").evaluateAll((groups) =>
                groups.map((group) => {
                  const box = (selector: string) =>
                    group.querySelector(selector)!.getBoundingClientRect();
                  const image = box("img");
                  const frame = box(".chat-image-frame");
                  const text = box(".chat-text");
                  const own =
                    group.classList.contains("user") &&
                    !group.classList.contains("chat-group--peer");
                  return {
                    frameGap: frame.right - image.right,
                    textGap: own ? text.right - image.right : image.left - text.left,
                    mediaGap: text.top - image.bottom,
                    user: group.classList.contains("user"),
                    paragraphGap: box(".chat-text > p + p").top - box(".chat-text > p").bottom,
                    width: image.width,
                    height: image.height,
                    laneWidth: box(".chat-group-messages").width,
                  };
                }),
              );
              for (const row of rows) {
                expect(Math.abs(row.frameGap)).toBeLessThanOrEqual(1);
                expect(Math.abs(row.textGap)).toBeLessThanOrEqual(1);
                expect(row.mediaGap).toBe(row.user ? 8 : 20);
                expect(row.paragraphGap).toBe(20);
                expect(row.width).toBeLessThanOrEqual(Math.min(400, row.laneWidth) + 1);
                expect(row.width / row.height).toBeCloseTo(width / height, 1);
              }
            },
          );
        },
      );
    },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
