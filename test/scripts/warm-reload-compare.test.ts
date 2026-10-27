import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import {
  createWarmReloadComparison,
  prepareWarmReloadBuild,
} from "../../scripts/perf/warm-reload-compare.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("accepts existing UI and full dist roots without relabeling their source revision", async () => {
  const directory = temporary.make("reload-compare-build-");
  const ui = path.join(directory, "control-ui");
  await mkdir(ui);
  const html = "<!doctype html><p>Synthetic build identity</p>";
  await writeFile(path.join(ui, "index.html"), html);
  for (const input of [directory, ui]) {
    const build = await prepareWarmReloadBuild(input, { directory, label: "base" });
    expect(build).toMatchObject({
      uiRoot: ui,
      revision: null,
      uiIndexSha256: createHash("sha256").update(html).digest("hex"),
    });
    await build.cleanup();
    expect(await readFile(path.join(ui, "index.html"), "utf8")).toBe(html);
  }
});

it("pairs warm samples, preserves missing paint evidence, and writes time-aligned unscaled sheets", async () => {
  const directory = temporary.make("reload-compare-report-");
  const image = new photon.PhotonImage(
    new Uint8Array(128 * 80 * 4).map((_, index) => (index % 4 === 3 ? 255 : 120)),
    128,
    80,
  );
  try {
    await writeFile(path.join(directory, "frame.png"), image.get_bytes());
  } finally {
    image.free();
  }
  const run = (milliseconds: number, states: number, warm = true) => ({
    warm,
    outputDir: directory,
    probe: {
      helloHandledMs: milliseconds,
      fcpMs: milliseconds,
      firstPaintedRowsMs: milliseconds,
      finalRowsDomMs: milliseconds,
      loafBlockingMs: milliseconds,
      cls: 0,
    },
    visual: {
      distinctStates: states + 2,
      lastVisualChangeMs: milliseconds,
      timeline: [{ atMs: 10, frame: "frame.png" }],
      unmasked: {
        distinctStates: states + 4,
        lastVisualChangeMs: milliseconds,
        timeline: [{ atMs: 10, frame: "frame.png" }],
      },
      visibleChangeCensus: {
        distinctStates: states,
        lastVisualChangeMs: milliseconds,
        timeline: [{ atMs: 10, frame: "frame.png" }],
      },
    },
  });
  const base = {
    arm: "base",
    route: "chat",
    runs: [run(999, 99, false), run(100, 5), run(300, 7)],
  };
  const candidate = {
    arm: "candidate",
    route: "chat",
    runs: [run(888, 88, false), run(90, 4), run(330, 6)],
  };
  const report = await createWarmReloadComparison([base, candidate], directory);
  expect(report.comparisons[0]?.summary).toMatchObject({
    helloHandledMs: {
      base: { median: 200, q1: 150, q3: 250, samples: 2 },
      candidate: { median: 210, q1: 150, q3: 270, samples: 2 },
      pairedDelta: { median: 10, q1: 0, q3: 20, samples: 2 },
      candidateBetterPairs: 1,
      candidateWorsePairs: 1,
    },
    visibleStates: { pairedDelta: { median: -1 }, candidateBetterPairs: 2 },
    auditedMainPaintMs: { base: null, candidate: null, pairedDelta: null },
  });
  expect(report.comparisons[0]?.pairs.map((pair) => pair.deltas.helloHandledMs)).toEqual([-10, 30]);
  const firstSheet = report.comparisons[0]!.pairs[0]!.contactSheets[0]!;
  const sheet = photon.PhotonImage.new_from_byteslice(
    await readFile(path.join(directory, firstSheet)),
  );
  try {
    expect([sheet.get_width(), sheet.get_height()]).toEqual([256, 124]);
    const pixels = sheet.get_raw_pixels();
    expect(pixels[44 * 256 * 4]).toBe(120);
    expect(pixels[(44 * 256 + 128) * 4]).toBe(120);
  } finally {
    sheet.free();
  }
  expect(await readFile(path.join(directory, "comparison.md"), "utf8")).toContain("unavailable");
  await expect(
    createWarmReloadComparison([base, { ...candidate, runs: [] }], directory),
  ).rejects.toThrow("sample counts must match");
  await expect(
    createWarmReloadComparison([base, { ...candidate, arm: "single" }], directory),
  ).rejects.toThrow("only base and candidate");
});
