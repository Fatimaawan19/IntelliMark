#!/usr/bin/env python3
import sys
import json
import os


def preprocess_image(image_path: str, output_path: str) -> bool:
    try:
        import cv2
        import numpy as np  # noqa: F401 – required by cv2 internals

        img = cv2.imread(image_path)
        if img is None:
            return False

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Upscale small images 
        h, w = gray.shape
        if max(h, w) < 2000:
            scale = 2000.0 / max(h, w)
            gray = cv2.resize(gray, None, fx=scale, fy=scale,
                              interpolation=cv2.INTER_CUBIC)

        # Non-local means denoising ->  better edge preservation than simple blur.
        denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)

        # Adaptive threshold handles uneven lighting common in phone-photographed submissions.
        thresh = cv2.adaptiveThreshold(
            denoised, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            15, 8,
        )

        cv2.imwrite(output_path, thresh)
        return True
    except Exception:
        return False


def main() -> None:
    try:
        data = json.loads(sys.stdin.read())
        image_paths: list = data.get("image_paths", [])
        output_dir: str = data.get("output_dir", "")

        if not output_dir:
            print(json.dumps({"success": False, "error": "output_dir is required"}))
            sys.exit(1)

        os.makedirs(output_dir, exist_ok=True)

        preprocessed: list = []
        for i, img_path in enumerate(image_paths):
            out_name = f"opencv_pre_{i}_{os.path.basename(img_path)}.png"
            out_path = os.path.join(output_dir, out_name)
            if preprocess_image(img_path, out_path):
                preprocessed.append(out_path)
            else:
                preprocessed.append(img_path)  # graceful fallback to original

        print(json.dumps({"success": True, "preprocessed_paths": preprocessed}))

    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
