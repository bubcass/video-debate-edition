#!/usr/bin/env python3
"""Transcribe a bounded MP4 excerpt with OpenAI and preserve word timings.

The API key is read only from OPENAI_API_KEY. It is never written to disk.
"""

import argparse
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid


def form_field(boundary, name, value):
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
            f"{value}\r\n").encode()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("media")
    p.add_argument("output", help="Normalised JSON transcript output")
    p.add_argument("--start", type=float, default=600, help="Excerpt start in video seconds")
    p.add_argument("--duration", type=float, default=1200, help="Excerpt length in seconds")
    args = p.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is not set in this Terminal session.")
    if not Path(args.media).is_file() or args.start < 0 or args.duration <= 0:
        raise SystemExit("Use an existing media file, nonnegative --start and positive --duration.")

    with tempfile.TemporaryDirectory(prefix="dail-openai-test-") as directory:
        audio = Path(directory) / "excerpt.mp3"
        subprocess.run([
            "ffmpeg", "-v", "error", "-ss", str(args.start), "-i", args.media,
            "-t", str(args.duration), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio),
        ], check=True)
        boundary = "----OpenAIForm" + uuid.uuid4().hex
        body = bytearray()
        for name, value in (("model", "whisper-1"), ("response_format", "verbose_json"),
                            ("timestamp_granularities[]", "word"), ("timestamp_granularities[]", "segment"),
                            ("language", "en")):
            body.extend(form_field(boundary, name, value))
        content_type = mimetypes.guess_type(audio.name)[0] or "audio/mpeg"
        body.extend((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"excerpt.mp3\"\r\n"
                     f"Content-Type: {content_type}\r\n\r\n").encode())
        body.extend(audio.read_bytes())
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        print("Uploading 20-minute excerpt to OpenAI for transcription…", flush=True)
        request = urllib.request.Request(
            "https://api.openai.com/v1/audio/transcriptions", data=bytes(body), method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            raw = json.loads(urllib.request.urlopen(request, timeout=1800).read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SystemExit(f"OpenAI transcription failed ({error.code}): {detail}") from None
        except Exception as error:
            raise SystemExit(f"OpenAI transcription failed: {error}") from None

    # whisper-1 returns its timestamp list at the response root. The subtitle
    # pipeline accepts a timed-word array directly, so preserve that losslessly.
    if raw.get("words"):
        segments = []
        for word in raw["words"]:
            value = word["word"].strip()
            if not value:
                continue
            start = round(word["start"] + args.start, 3)
            end = round(max(word["end"], word["start"] + .01) + args.start, 3)
            segments.append({"word": value, "start": start, "end": end})
    else:
        segments = []
        for segment in raw.get("segments", []):
            words = [{"word": w["word"], "start": round(w["start"] + args.start, 3), "end": round(w["end"] + args.start, 3)}
                     for w in segment.get("words", [])]
            if words:
                segments.append({"start": words[0]["start"], "end": words[-1]["end"],
                                 "text": " ".join(w["word"] for w in words), "words": words})
    if not segments:
        raise SystemExit("The API response contained no word-timed segments; raw response was not saved.")
    out = Path(args.output)
    out.write_text(json.dumps(segments, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out}: {len(segments)} timed entries, {segments[0]['start']:.1f}s–{segments[-1]['end']:.1f}s.")


if __name__ == "__main__":
    main()
