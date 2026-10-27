#!/usr/bin/env python3
"""Build the benchmark corpus: real recitations under simulated mosque/phone conditions.

Source audio: Tilawa's test corpora (EveryAyah studio recitations, TLOG / RetaSy crowd-sourced
phone recordings, user recordings). Output: 16 kHz mono WAV streams + manifest.json with the
expected verse sequence for every stream.

Conditions
  clean   original audio
  mild    small room: RT60 0.8 s, DRR +4 dB, pink noise SNR 20 dB, quiet (-30 dBFS)
  hall    mosque hall, several rows back: RT60 1.6 s, DRR 0 dB, babble+pink SNR 12 dB,
          coughs and footsteps, distant (-36 dBFS)
  pocket  hall + phone in a pocket: cloth low-pass 2.5 kHz, SNR 6 dB, -40 dBFS

Stream kinds
  single  one verse, 1 s lead-in, 2.5 s tail (fresh session per stream)
  salah   two rak'ahs: Fatihah, surah passage, 12 s transition (ruku/sujud), Fatihah, passage
  midstart  multi-verse passage with the first 3 s cut (listening starts mid-verse)
  noise   60 s of babble, coughs, reversed recitation and shuffled-syllable recitation:
          speech-like Arabic audio that is not Quran in order; expected: no verses at all

Usage: python3 bench/make_corpus.py <tilawa-benchmark-dir> <out-dir> [--singles N]
"""
import json, os, subprocess, sys, random
import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve, butter, sosfilt

SR = 16000
SRC = sys.argv[1]
OUT = sys.argv[2]
N_SINGLES = int(sys.argv[sys.argv.index("--singles") + 1]) if "--singles" in sys.argv else 120
rng = np.random.default_rng(20261027)
random.seed(20261027)

FIX = {"tlog_m043_010_043": (10, 42), "tlog_m044_010_043": (10, 42)}
DROP = {"tlog_m008_107_001"}


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def rms(x):
    return float(np.sqrt(np.mean(x * x) + 1e-20))


def speech_rms(x):
    # RMS over the louder half of 20 ms frames (ignores silences)
    f = 320
    n = len(x) // f
    if n == 0:
        return rms(x)
    e = np.sqrt(np.mean(x[: n * f].reshape(n, f) ** 2, axis=1))
    e = np.sort(e)[n // 2:]
    return float(np.sqrt(np.mean(e * e)) + 1e-12)


def pink(n):
    w = rng.standard_normal(n)
    X = np.fft.rfft(w)
    f = np.arange(len(X)); f[0] = 1
    X = X / np.sqrt(f)
    y = np.fft.irfft(X, n)
    return y / rms(y)


def rir(rt60, drr_db):
    n = int(rt60 * SR * 1.2)
    t = np.arange(n) / SR
    tail = rng.standard_normal(n) * np.exp(-6.9078 * t / rt60)
    pre = int(0.010 * SR)
    tail[:pre] = 0
    # air absorption: progressively darker tail
    sos = butter(2, 4000, "low", fs=SR, output="sos")
    tail = 0.6 * tail + 0.4 * sosfilt(sos, tail)
    h = np.zeros(n)
    h[0] = 1.0
    for d, g in [(0.007, 0.5), (0.013, 0.35), (0.021, 0.3), (0.034, 0.25)]:  # early reflections
        h[int(d * SR)] += g * (1 if rng.random() > 0.5 else -1)
    e_direct = 1.0
    e_tail = float(np.sum(tail ** 2))
    tail *= np.sqrt(e_direct / (e_tail * 10 ** (drr_db / 10)))
    return h + tail


def cough():
    d = rng.uniform(0.18, 0.4)
    n = int(d * SR)
    t = np.arange(n) / SR
    env = (1 - np.exp(-t / 0.004)) * np.exp(-t / (d / 3))
    sos = butter(2, [250, 3500], "band", fs=SR, output="sos")
    x = sosfilt(sos, rng.standard_normal(n)) * env
    return x / (np.max(np.abs(x)) + 1e-9)


def footstep():
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * rng.uniform(60, 110) * t) * np.exp(-t / 0.03)
    return x


class Bank:
    def __init__(self, clips):
        self.clips = clips

    def babble(self, n, voices=6):
        out = np.zeros(n)
        for _ in range(voices):
            c = self.clips[rng.integers(len(self.clips))][::-1]  # reversed speech: speech-like, not Quran
            if len(c) < n:
                c = np.tile(c, n // len(c) + 1)
            s = rng.integers(0, len(c) - n + 1)
            seg = c[s:s + n]
            out += seg / (speech_rms(seg) + 1e-9)
        return out / (rms(out) + 1e-9)

    def shuffled_syllables(self, n):
        out = []
        tot = 0
        while tot < n:
            c = self.clips[rng.integers(len(self.clips))]
            L = int(rng.uniform(0.18, 0.35) * SR)
            if len(c) <= L:
                continue
            s = rng.integers(0, len(c) - L)
            seg = c[s:s + L] * np.hanning(L)
            out.append(seg / (speech_rms(seg) + 1e-9))
            tot += L
        return np.concatenate(out)[:n]


def degrade(x, cond, bank):
    if cond == "clean":
        return x.copy()
    p = {
        "mild": dict(rt60=0.8, drr=4, snr=20, level=-30, babble=0.0, coughs=0, lp=None),
        "hall": dict(rt60=1.6, drr=0, snr=12, level=-36, babble=0.6, coughs=1 / 8, lp=None),
        "pocket": dict(rt60=1.6, drr=0, snr=6, level=-40, babble=0.6, coughs=1 / 8, lp=2500),
    }[cond]
    sp = speech_rms(x)
    y = fftconvolve(x, rir(p["rt60"], p["drr"]))[: len(x)]
    y *= sp / (speech_rms(y) + 1e-12)
    n = len(y)
    noise = (1 - p["babble"]) * pink(n) + p["babble"] * bank.babble(n)
    noise /= rms(noise) + 1e-12
    y = y + noise * speech_rms(y) * 10 ** (-p["snr"] / 20)
    if p["coughs"]:
        k = int(n / SR * p["coughs"]) + 1
        for _ in range(k):
            c = cough() * speech_rms(y) * 10 ** (rng.uniform(3, 9) / 20) * 1.4
            s = rng.integers(0, max(1, n - len(c)))
            y[s:s + len(c)] += c[: n - s]
        for _ in range(k * 2):
            f = footstep() * speech_rms(y) * 0.8
            s = rng.integers(0, max(1, n - len(f)))
            y[s:s + len(f)] += f[: n - s]
    if p["lp"]:
        y = sosfilt(butter(4, p["lp"], "low", fs=SR, output="sos"), y)
    y *= 10 ** (p["level"] / 20) / (speech_rms(y) + 1e-12)
    return np.clip(y, -1, 1)


def bed(n, cond, bank):
    """Background-only audio for gaps, at the level the condition would have."""
    if cond == "clean":
        return rng.standard_normal(n) * 10 ** (-70 / 20)
    return None  # filled by degrading silence + noise together below


def write(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wavfile.write(path, SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def main():
    samples = []
    for d in ["test_corpus", "test_corpus_v2", "test_corpus_v3"]:
        man = json.load(open(f"{SRC}/{d}/manifest.json"))["samples"]
        for s in man:
            if s["id"] in DROP:
                continue
            ev = [(v["surah"], v["ayah"]) for v in s["expected_verses"]]
            if s["id"] in FIX:
                ev = [FIX[s["id"]]]
            alts = [[(v["surah"], v["ayah"]) for v in alt] for alt in s.get("also_accept", [])]
            samples.append(dict(id=f"{d}/{s['id']}", path=f"{SRC}/{d}/{s['file']}", expected=ev, alts=alts,
                                source=s.get("source"), category=s.get("category"), corpus=d))
    # dedupe by file content path name within corpora (v1/v3 share some files)
    seen = set(); uniq = []
    for s in samples:
        k = os.path.basename(s["path"])
        if k in seen:
            continue
        seen.add(k); uniq.append(s)
    samples = uniq
    print("source samples", len(samples))
    audio = {}
    for s in samples:
        audio[s["id"]] = load(s["path"])
    bank = Bank([audio[s["id"]] for s in samples])

    singles = [s for s in samples if len(s["expected"]) == 1 and s["corpus"] == "test_corpus_v3"]
    others = [s for s in samples if len(s["expected"]) == 1 and s["corpus"] != "test_corpus_v3"]
    random.shuffle(singles); random.shuffle(others)
    pick = singles[: int(N_SINGLES * 0.75)] + others[: N_SINGLES - int(N_SINGLES * 0.75)]
    multis = [s for s in samples if len(s["expected"]) > 1 and s["expected"][0] != (1, 1)]
    fatiha = next(s for s in samples if s["expected"] == [(1, i) for i in range(1, 8)])

    streams = []
    conds = ["clean", "mild", "hall", "pocket"]

    def emit(kind, sid, parts, expected, optional=(), segments=None):
        # parts: list of ("audio", array) / ("gap", seconds)
        for cond in conds:
            chunks = []
            seg_times = []
            t = 0.0
            for kind_p, val in parts:
                if kind_p == "gap":
                    n = int(val * SR)
                    chunks.append(np.zeros(n)); t += val
                else:
                    seg_times.append((t, t + len(val) / SR))
                    chunks.append(val); t += len(val) / SR
            x = np.concatenate(chunks)
            if cond == "clean":
                y = x + rng.standard_normal(len(x)) * 10 ** (-70 / 20)
            else:
                # degrade speech, then the noise bed covers gaps too (noise is added over the full stream)
                y = degrade(x if speech_rms(x) > 1e-6 else x + 1e-4, cond, bank)
            fn = f"{cond}/{kind}/{sid.replace('/', '__')}.wav"
            write(f"{OUT}/{fn}", y)
            streams.append(dict(id=f"{cond}:{kind}:{sid}", cond=cond, kind=kind, file=fn,
                                duration=round(len(y) / SR, 3), expected=expected, optional=list(optional),
                                segments=seg_times))

    for s in pick:
        emit("single", s["id"], [("gap", 1.0), ("audio", audio[s["id"]]), ("gap", 2.5)],
             [list(v) for v in s["expected"]], optional=[[list(v) for v in alt] for alt in s["alts"]])
    random.shuffle(multis)
    pairs = [(multis[i], multis[(i + 1) % len(multis)]) for i in range(0, min(len(multis), 24), 2)]
    for i, (a, b) in enumerate(pairs):
        F = audio[fatiha["id"]]
        parts = [("gap", 2.0), ("audio", F), ("gap", 3.0), ("audio", audio[a["id"]]), ("gap", 12.0),
                 ("audio", F), ("gap", 3.0), ("audio", audio[b["id"]]), ("gap", 3.0)]
        exp = [list(v) for v in fatiha["expected"] + a["expected"] + fatiha["expected"] + b["expected"]]
        emit("salah", f"s{i:02d}_{a['expected'][0][0]}_{b['expected'][0][0]}", parts, exp)
    for s in multis[:16]:
        x = audio[s["id"]][int(3.0 * SR):]
        emit("midstart", s["id"], [("audio", x), ("gap", 2.5)], [list(v) for v in s["expected"][1:]],
             optional=[list(s["expected"][0])])
    for i in range(10):
        n = 60 * SR
        x = 0.5 * bank.babble(n, voices=3) + 0.8 * bank.shuffled_syllables(n)
        rev = bank.clips[rng.integers(len(bank.clips))][::-1]
        s0 = rng.integers(0, n // 2)
        x[s0:s0 + min(len(rev), n - s0)] += rev[: n - s0] / (speech_rms(rev) + 1e-9)
        for _ in range(8):
            c = cough() * 1.5
            st = rng.integers(0, n - len(c))
            x[st:st + len(c)] += c
        x *= 10 ** (-28 / 20) / (speech_rms(x) + 1e-12)
        emit("noise", f"n{i:02d}", [("audio", x)], [])
    json.dump(dict(streams=streams), open(f"{OUT}/manifest.json", "w"), indent=1)
    from collections import Counter
    print(Counter((s["cond"], s["kind"]) for s in streams))


main()
