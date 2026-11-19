# 本地 OCR 模型

使用 Tesseract.js（Apache-2.0）及 @tesseract.js-data 的简体中文、英文 LSTM 模型（Apache-2.0）。模型由锁定的 npm 包准备，运行 npm run prepare:ocr 复制 4.0.0_best_int 压缩模型；构建时附带到应用，运行识别不访问模型 CDN 或上传图片。完整上游许可证位于 npm 包中，并随发布包附带。

上游：https://github.com/naptha/tesseract.js 与 https://github.com/naptha/tessdata
