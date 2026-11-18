import base64
import contextlib
import json
import os
import sys
import tempfile
import traceback


def initialize():
    from faster_whisper import WhisperModel
    import argostranslate.package
    import argostranslate.translate

    installed = {(p.from_code, p.to_code) for p in argostranslate.package.get_installed_packages()}
    required = {("zh", "en"), ("en", "ja")}
    if not required.issubset(installed):
        print("Downloading translation models on first use...", file=sys.stderr)
        argostranslate.package.update_package_index()
        packages = argostranslate.package.get_available_packages()
        for source, target in sorted(required - installed):
            package = next(p for p in packages if p.from_code == source and p.to_code == target)
            argostranslate.package.install_from_path(package.download())
    print("Loading speech model; first use may download it...", file=sys.stderr)
    model = WhisperModel("small", device="cpu", compute_type="int8")
    return model, argostranslate.translate


def main():
    with contextlib.redirect_stdout(sys.stderr):
        model, translate = initialize()
    for line in sys.stdin:
        filename = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as audio:
                filename = audio.name
                audio.write(base64.b64decode(line, validate=True))
            with contextlib.redirect_stdout(sys.stderr):
                segments, info = model.transcribe(filename, beam_size=3, vad_filter=True)
                original = " ".join(segment.text.strip() for segment in segments).strip()
                if original and info.language in ("zh", "en"):
                    translated = translate.translate(original, info.language, "ja")
                else:
                    translated = ""
            print(json.dumps({"original": original, "translation": translated}, ensure_ascii=True), flush=True)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"error": "local engine failed"}), flush=True)
        finally:
            if filename:
                os.unlink(filename)


if __name__ == "__main__":
    main()
