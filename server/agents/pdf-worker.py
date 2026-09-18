"""Private, resource-limited PDF preparation. Never executes PDF content."""
import json
import os
from pathlib import Path
import resource
import sys

# Apply bounds before loading the parser or untrusted document.
resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
resource.setrlimit(resource.RLIMIT_FSIZE, (300 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
os.umask(0o077)

import pikepdf  # noqa: E402

PART_BYTES = 48_000_000
INPUT_BYTES = 250 * 1024 * 1024
OUTPUT_BYTES = 300 * 1024 * 1024
MAX_PAGES = 1000
MAX_PARTS = 8


class PreparationError(Exception):
    pass


def prepare(input_path, part_limit=PART_BYTES):
    """part_limit is only overridden by isolated parser regression fixtures."""
    input_path = Path(input_path)
    if input_path.stat().st_size > INPUT_BYTES:
        raise PreparationError("PDF_TOO_LARGE")
    try:
        pdf = pikepdf.open(input_path, attempt_recovery=False)
    except pikepdf.PasswordError as error:
        raise PreparationError("PDF_ENCRYPTED") from error
    except (pikepdf.PdfError, ValueError) as error:
        raise PreparationError("PDF_INVALID") from error
    with pdf:
        if pdf.is_encrypted:
            raise PreparationError("PDF_ENCRYPTED")
        page_count = len(pdf.pages)
        if page_count < 1:
            raise PreparationError("PDF_EMPTY")
        if page_count > MAX_PAGES:
            raise PreparationError("PDF_TOO_MANY_PAGES")
        if pdf.check():
            raise PreparationError("PDF_INVALID")
        if input_path.stat().st_size <= part_limit:
            return {"pageCount": page_count, "parts": [{"filename": input_path.name, "startPage": 1, "endPage": page_count, "byteLength": input_path.stat().st_size}]}

        # Lossless only: preserve content/image encodings; remove display thumbnails.
        for page in pdf.pages:
            if "/Thumb" in page.obj:
                del page.obj["/Thumb"]
        optimized_path = input_path.parent / "optimized.pdf"
        save_options = {"compress_streams": True, "object_stream_mode": pikepdf.ObjectStreamMode.generate, "recompress_flate": True}
        pdf.save(optimized_path, **save_options)
        optimized_size = optimized_path.stat().st_size
        if optimized_size <= part_limit:
            return {"pageCount": page_count, "parts": [{"filename": optimized_path.name, "startPage": 1, "endPage": page_count, "byteLength": optimized_size}]}
        optimized_path.unlink()

        parts = []
        output_bytes = 0

        def split(first, last):
            nonlocal output_bytes
            if len(parts) >= MAX_PARTS:
                raise PreparationError("PDF_TOO_MANY_PARTS")
            scratch = input_path.parent / "candidate.pdf"
            with pikepdf.Pdf.new() as partial:
                partial.pages.extend(pdf.pages[first:last])
                partial.save(scratch, **save_options)
            size = scratch.stat().st_size
            if size > part_limit:
                scratch.unlink()
                if last - first == 1:
                    raise PreparationError("PDF_PAGE_TOO_LARGE")
                middle = first + (last - first) // 2
                split(first, middle)
                split(middle, last)
                return
            output_bytes += size
            if output_bytes > OUTPUT_BYTES:
                raise PreparationError("PDF_OUTPUT_TOO_LARGE")
            path = input_path.parent / ("part-%02d.pdf" % (len(parts) + 1))
            scratch.rename(path)
            parts.append({"filename": path.name, "startPage": first + 1, "endPage": last, "byteLength": size})

        split(0, page_count)
        return {"pageCount": page_count, "parts": parts}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise PreparationError("PDF_INVALID")
        result = prepare(sys.argv[1])
        print(json.dumps(result, separators=(",", ":")))
    except PreparationError as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        sys.exit(1)
    except Exception:
        # Parser paths, PDF text, and diagnostic content never cross the boundary.
        print('{"error":"PDF_PREPARATION_FAILED"}')
        sys.exit(1)
