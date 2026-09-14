import argparse
import json
import os
import sys
import re

try:
    import cv2
    import numpy as np
    import pytesseract
    from PIL import Image
except ImportError as e:
    print(json.dumps({"success": False, "error": f"Missing dependency: {e}"}))
    sys.exit(1)


# Configure Tesseract path (Windows default)
TESSERACT_PATH = os.environ.get("TESSERACT_PATH", r"C:\Program Files\Tesseract-OCR\tesseract.exe")
if os.path.exists(TESSERACT_PATH):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH


def preprocess_for_ocr(image_path, mode="adaptive"):
    """
    Apply OpenCV preprocessing for better OCR results on handwritten content.

    Modes:
    - 'adaptive': Adaptive thresholding (good for varying lighting)
    - 'denoise': Aggressive denoising (good for noisy/scanned images)
    - 'sharp': Sharpening + threshold (good for blurry handwriting)
    - 'raw': Just convert to grayscale
    - 'morph': Morphological operations to clean up handwriting
    - 'upscale': Heavy upscaling for small/low-res images
    """
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")

    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Resize aggressively for better OCR
    height, width = gray.shape
    if width < 2000:
        scale = 2000 / width
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    if mode == "raw":
        return gray

    if mode == "upscale":
        # Just upscale further with sharpening
        upscaled = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
        kernel = np.array([[0, -0.5, 0], [-0.5, 3, -0.5], [0, -0.5, 0]])
        sharpened = cv2.filter2D(upscaled, -1, kernel)
        return sharpened

    if mode == "adaptive":
        # Adaptive thresholding - good for handwritten text with varying brightness
        denoised = cv2.fastNlMeansDenoising(gray, h=10)
        thresh = cv2.adaptiveThreshold(
            denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10
        )
        return thresh

    if mode == "denoise":
        # Heavy denoising
        denoised = cv2.fastNlMeansDenoising(gray, h=15)
        _, thresh = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return thresh

    if mode == "sharp":
        # Sharpen + Otsu threshold
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        sharpened = cv2.filter2D(gray, -1, kernel)
        _, thresh = cv2.threshold(sharpened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return thresh

    if mode == "morph":
        # Morphological operations to clean up handwriting
        # First denoise
        denoised = cv2.fastNlMeansDenoising(gray, h=12)
        # Apply bilateral filter to preserve edges while removing noise
        bilateral = cv2.bilateralFilter(denoised, 9, 75, 75)
        # Otsu threshold
        _, thresh = cv2.threshold(bilateral, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Morphological closing to connect broken letters
        kernel = np.ones((1, 1), np.uint8)
        closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        return closed

    return gray


def run_tesseract(image, lang="eng", psm=6):
    """Run Tesseract OCR with given config."""
    config = f"-l {lang} --oem 1 --psm {psm} -c preserve_interword_spaces=1"
    try:
        text = pytesseract.image_to_string(image, config=config)
        return text.strip()
    except Exception as e:
        return ""


def score_text(text):
    """Score the quality of OCR text - higher score is better.

    Favors longer, complete words over fragmented short tokens.
    """
    if not text:
        return 0
    # Common English words to verify recognition quality
    common_words = {
        "the", "and", "is", "of", "to", "in", "a", "that", "it", "with",
        "for", "as", "are", "this", "be", "by", "on", "an", "or", "from",
        "variable", "experiment", "random", "value", "function", "data",
        "result", "answer", "question", "method", "process", "system",
        "tossing", "coin", "head", "tail", "outcome", "input", "output",
    }

    lines = text.split("\n")
    score = 0
    real_word_count = 0

    for line in lines:
        line = line.strip()
        if not line:
            continue
        letters = sum(1 for c in line if c.isalpha())
        non_space = sum(1 for c in line if not c.isspace())
        if non_space == 0:
            continue
        # Lines with more than 50% letters are valuable
        if letters / non_space > 0.5:
            score += letters

        # Bonus for recognizable English words
        words = line.lower().split()
        for w in words:
            # Strip punctuation
            clean_w = "".join(c for c in w if c.isalpha())
            if len(clean_w) >= 3:
                real_word_count += 1
                # Big bonus for common words (proves OCR worked)
                if clean_w in common_words:
                    score += 50
                # Bonus for word length (longer = more accurate)
                if len(clean_w) >= 5:
                    score += 10

    # Major bonus if we have at least 10 real words
    if real_word_count >= 10:
        score += 100
    if real_word_count >= 20:
        score += 200

    return score


def clean_text(text):
    """Remove noise lines from OCR output."""
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        line = line.strip()
        if not line:
            cleaned.append("")
            continue

        # Count letters vs non-letters
        non_space = sum(1 for c in line if not c.isspace())
        if non_space == 0:
            continue

        letters = sum(1 for c in line if c.isalpha())
        symbols = sum(1 for c in line if not c.isalnum() and not c.isspace())

        # Skip noise lines
        if non_space > 5 and letters / non_space < 0.3:
            continue
        if non_space > 5 and symbols / non_space > 0.5:
            continue

        # Skip very short lines that are just fragments (less than 3 letters)
        if letters < 3 and non_space < 5:
            continue

        # Skip lines with mostly fragments
        words = line.split()
        if len(words) > 5:
            fragments = sum(1 for w in words if len(w) <= 2 and not w.isalpha())
            if fragments / len(words) > 0.5:
                continue

        # Clean special chars but keep punctuation
        cleaned_line = re.sub(r"[^\x20-\x7E]", " ", line)
        cleaned_line = re.sub(r"\s+", " ", cleaned_line).strip()
        if cleaned_line:
            cleaned.append(cleaned_line)

    # Remove near-duplicate consecutive lines (common with PSM 11/12 sparse modes)
    deduped = []
    for line in cleaned:
        if not line:
            if deduped and deduped[-1] != "":
                deduped.append(line)
            continue
        # Check if this line is similar to any previous line
        is_dup = False
        line_lower = line.lower().strip()
        line_words = set(w for w in line_lower.split() if len(w) >= 3)
        for prev in deduped[-5:]:  # Check last 5 lines
            if not prev:
                continue
            prev_lower = prev.lower().strip()
            # Exact match
            if line_lower == prev_lower:
                is_dup = True
                break
            # Substring match (one contains the other)
            if line_lower in prev_lower or prev_lower in line_lower:
                # Only consider duplicate if substantial overlap (>5 chars)
                if min(len(line_lower), len(prev_lower)) > 5:
                    is_dup = True
                    break
            # Word overlap > 70%
            prev_words = set(w for w in prev_lower.split() if len(w) >= 3)
            if len(line_words) >= 3 and len(prev_words) >= 3:
                overlap = len(line_words & prev_words)
                if overlap / min(len(line_words), len(prev_words)) > 0.7:
                    is_dup = True
                    break
        if not is_dup:
            deduped.append(line)

    return "\n".join(deduped).strip()


def ocr_image(image_path, lang="eng"):
    """
    Try multiple preprocessing and PSM combinations, return the best.
    """
    modes = ["raw", "upscale", "adaptive", "denoise", "sharp", "morph"]
    psm_modes = [3, 6, 11, 4, 12]  # auto, uniform block, sparse, single column, sparse with OSD

    best_text = ""
    best_score = 0
    best_config = ""

    for mode in modes:
        try:
            preprocessed = preprocess_for_ocr(image_path, mode=mode)
        except Exception as e:
            continue

        for psm in psm_modes:
            text = run_tesseract(preprocessed, lang=lang, psm=psm)
            cleaned = clean_text(text)
            score = score_text(cleaned)

            if score > best_score:
                best_score = score
                best_text = cleaned
                best_config = f"{mode}_psm{psm}"

    return {
        "text": best_text,
        "score": best_score,
        "config": best_config,
    }


def main():
    parser = argparse.ArgumentParser(description="OCR with OpenCV preprocessing")
    parser.add_argument("--image", required=True, help="Path to image file")
    parser.add_argument("--lang", default="eng", help="Tesseract language (default: eng)")
    parser.add_argument("--output-json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    if not os.path.exists(args.image):
        result = {"success": False, "error": f"Image not found: {args.image}"}
        print(json.dumps(result))
        sys.exit(1)

    try:
        result = ocr_image(args.image, lang=args.lang)
        output = {
            "success": True,
            "text": result["text"],
            "text_length": len(result["text"]),
            "config_used": result["config"],
            "score": result["score"],
        }
        if args.output_json:
            print(json.dumps(output))
        else:
            print(result["text"])
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
