import { describe, expect, it } from "vitest";
import { extensionFor, formatDuration, formatSize, median, pickRecordingType, playbackGainDb, recordingFileName, seekSeconds, verseStartWall } from "./recording";

describe("recording helpers", () => {
  it("prefers Opus in WebM, falls back to MP4 (Safari)", () => {
    expect(pickRecordingType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingType((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickRecordingType(() => false)).toBeNull();
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("audio/mp4")).toBe("m4a");
  });

  it("names files safely for phones", () => {
    const t = new Date(2026, 10, 2, 13, 5).getTime();
    expect(recordingFileName(t, "Jummah", "audio/webm;codecs=opus")).toBe("Ayah Live 2026-11-02 13.05 Jummah.webm");
    expect(recordingFileName(t, null, "audio/mp4")).toBe("Ayah Live 2026-11-02 13.05.m4a");
  });

  it("lifts quiet, distant recordings and leaves loud ones alone", () => {
    expect(playbackGainDb(-40)).toBe(20);
    expect(playbackGainDb(-60)).toBe(24); // capped
    expect(playbackGainDb(-12)).toBe(0); // never turned down
    expect(playbackGainDb(undefined)).toBe(6);
  });

  it("starts a verse just before it began, within the recording", () => {
    const rec = { startedWall: 1_000_000, durationMs: 600_000 };
    expect(seekSeconds(1_027_000, rec)).toBeCloseTo(26.5);
    expect(seekSeconds(999_000, rec)).toBe(0);
    expect(seekSeconds(2_000_000, rec)).toBe(599);
  });

  it("places verses without their own timing between measured neighbours, by words", () => {
    const words = () => 4;
    const es = [
      { v: { s: 1, a: 1 }, wall: 15_000, fromWall: 2_000, fromSure: true },
      { v: { s: 1, a: 2 }, wall: 15_100, fromWall: 12_700 }, // found late: estimate is off
      { v: { s: 1, a: 3 }, wall: 16_000, fromWall: 14_000, fromSure: true },
      { v: { s: 1, a: 4 }, wall: 21_000, fromWall: 19_000, fromSure: true },
      { v: { s: 1, a: 5 }, wall: 26_000 }, // last, nothing measured after it
    ];
    expect(verseStartWall(es, 1, words)).toBe(8_000);
    expect(verseStartWall(es, 2, words)).toBe(14_000);
    expect(verseStartWall(es, 4, words)).toBe(23_500); // falls back to 2.5 s before confirmation
  });

  it("formats durations, sizes and medians", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatSize(14_200_000)).toBe("14 MB");
    expect(formatSize(2_340_000)).toBe("2.3 MB");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeUndefined();
  });
});
