/**
 * PDF text extraction via pdfjs-dist (legacy build, Node-compatible).
 * Returns null when the PDF has no text layer (image-only / scanned PDF).
 */

// Use the legacy build for Node — main build assumes browser globals.
// @ts-ignore - no type defs for legacy subpath
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfExtractResult = {
  text: string | null;
  page_count: number;
  is_image_only: boolean;
  warning: string | null;
};

/**
 * Extract text from a PDF buffer. Returns null text if the document has no
 * meaningful text layer (heuristic: <50 chars across all pages).
 */
export async function extractPdfText(buffer: Buffer): Promise<PdfExtractResult> {
  try {
    // Convert Buffer to Uint8Array for pdfjs.
    const uint8 = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );

    const loadingTask = pdfjsLib.getDocument({
      data: uint8,
      // Silence pdfjs verbosity on stderr.
      verbosity: 0,
      useSystemFonts: true,
    });

    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const pages: string[] = [];

    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(pageText);
    }

    const text = pages.join("\n\n").trim();
    const isImageOnly = text.length < 50;

    return {
      text: isImageOnly ? null : text,
      page_count: pageCount,
      is_image_only: isImageOnly,
      warning: isImageOnly
        ? "PDF appears to be image-only (no text layer). OCR not supported."
        : null,
    };
  } catch (err) {
    return {
      text: null,
      page_count: 0,
      is_image_only: false,
      warning: `PDF extraction failed: ${(err as Error).message}`,
    };
  }
}
