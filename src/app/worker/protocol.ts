import type { PipelineEvent } from "../../core/pipeline";
import type { PrayerContext, Sensitivity } from "../../core/types";

export interface EngineSettings {
  prayer: PrayerContext;
  sensitivity: Sensitivity;
  conditioning: boolean;
}

export type ToWorker =
  | { type: "init"; baseUrl: string; settings: EngineSettings }
  | { type: "audio-port"; port: MessagePort }
  | { type: "start"; sampleRate: number }
  | { type: "stop" }
  | { type: "settings"; settings: EngineSettings };

export type FromWorker =
  | { type: "loading"; stage: "model" | "corpus" | "text" | "runtime"; loaded: number; total: number; cached: boolean }
  | { type: "ready"; recognizer: string; threads: number; loadMs: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "events"; events: PipelineEvent[] }
  | { type: "stats"; rtf: number; backlogSec: number; audioSec: number; maxChunkMs: number }
  | { type: "stopped" };
