#!/usr/bin/env python3
"""Resumably transcribe a long recording with OpenAI whisper-1 word timings."""

import argparse
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def request_transcript(audio, api_key):
    boundary = "----OpenAIForm" + uuid.uuid4().hex
    body = bytearray()
    for name, value in (("model", "whisper-1"), ("response_format", "verbose_json"),
                        ("timestamp_granularities[]", "word"), ("language", "en")):
        body.extend((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode())
    body.extend((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"excerpt.mp3\"\r\n"
                 f"Content-Type: {mimetypes.guess_type(audio.name)[0] or 'audio/mpeg'}\r\n\r\n").encode())
    body.extend(audio.read_bytes()); body.extend(f"\r\n--{boundary}--\r\n".encode())
    request = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=bytes(body), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(urllib.request.urlopen(request, timeout=1800).read())


def normalise(raw, offset):
    words = []
    for word in raw.get("words", []):
        text = word.get("word", "").strip()
        if text:
            start = round(float(word["start"]) + offset, 3)
            end = round(max(float(word["end"]), float(word["start"]) + .01) + offset, 3)
            words.append({"word": text, "start": start, "end": end})
    if not words:
        raise ValueError("API response contained no word timestamps")
    return words


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("media"); p.add_argument("output_dir")
    p.add_argument("--chunk-seconds", type=int, default=1200)
    p.add_argument("--duration", type=float, help="Override media duration when ffprobe is unavailable")
    args = p.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key: raise SystemExit("OPENAI_API_KEY is not set in this Terminal session.")
    media = Path(args.media); root = Path(args.output_dir); chunks = root / "chunks"
    if not media.is_file() or args.chunk_seconds <= 0: raise SystemExit("Use an existing media file and positive chunk length.")
    if args.duration is None:
        args.duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(media)]))
    chunks.mkdir(parents=True, exist_ok=True); all_words = []
    total = (int(args.duration) + args.chunk_seconds - 1) // args.chunk_seconds
    for index in range(total):
        start = index * args.chunk_seconds; length = min(args.chunk_seconds, args.duration - start)
        saved = chunks / f"{index:03d}.json"
        if saved.exists():
            words = json.loads(saved.read_text(encoding="utf-8")); print(f"Chunk {index+1}/{total}: reusing {saved.name}")
        else:
            with tempfile.TemporaryDirectory(prefix="dail-openai-") as directory:
                audio = Path(directory) / "excerpt.mp3"
                subprocess.run(["ffmpeg", "-v", "error", "-ss", str(start), "-i", str(media), "-t", str(length), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio)], check=True)
                print(f"Chunk {index+1}/{total}: uploading {start/3600:.2f}–{(start+length)/3600:.2f} hours…", flush=True)
                for attempt in range(3):
                    try: raw = request_transcript(audio, key); break
                    except urllib.error.HTTPError as error:
                        if error.code < 500 or attempt == 2: raise SystemExit(f"API error {error.code}: {error.read().decode(errors='replace')}")
                        time.sleep(10 * (attempt + 1))
                words = normalise(raw, start)
                saved.write_text(json.dumps(words, ensure_ascii=False) + "\n", encoding="utf-8")
        all_words.extend(words)
    combined = root / "whisper-1-words.json"
    combined.write_text(json.dumps(all_words, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Complete: {len(all_words)} timed words in {combined}")


if __name__ == "__main__": main()
