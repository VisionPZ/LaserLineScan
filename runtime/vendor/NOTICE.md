# Browser dependencies

- OpenCV.js 4.13.0: downloaded from https://docs.opencv.org/4.x/opencv.js on 17 September 2026. Apache 2.0; see OPENCV-LICENSE.txt. The vendored source is wrapped for ES modules (`globalThis` root, module-local configuration and default export). It performs live ChArUco detection, optional marker-corner refinement and solvePnP inside the browser worker.
- PptxGenJS 4.0.1: official npm `pptxgenjs` package, `dist/pptxgen.bundle.js`, with a default ES module export. MIT; see PPTXGENJS-LICENSE.txt. Bundle retains dependency licence notices. Used for client-side, native editable PowerPoint reports.

Both libraries are served locally. No third-party service receives images or calibration results.
