import { readFileSync, mkdirSync } from 'fs';
import { extractText as pdfExtractText, getDocumentProxy, extractImages } from 'unpdf';
import { createWorker } from 'tesseract.js';
import { PNG } from 'pngjs';
import { OCR_CACHE_PATH } from '../env.js';
import { readCsv } from './spreadsheet/csv.js';
import { renderWorkbook } from './spreadsheet/render.js';
import { isBlankRow, type Workbook } from './spreadsheet/types.js';
import { readXlsx } from './spreadsheet/xlsx.js';

const OCR_LANGS = 'eng+chi_sim';

/**
 * Creates a tesseract worker with an explicit cache dir. Without `cachePath`
 * tesseract.js downloads its `*.traineddata` files into the process CWD.
 */
async function createOcrWorker() {
	mkdirSync(OCR_CACHE_PATH, { recursive: true });
	return createWorker(OCR_LANGS, undefined, { cachePath: OCR_CACHE_PATH });
}

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME_TYPE = 'text/csv';

/** Infers the MIME type this module's extractors understand from a filename's extension. */
export function inferMimeType(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith('.pdf')) return 'application/pdf';
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.xlsx')) return XLSX_MIME_TYPE;
	if (lower.endsWith('.csv')) return CSV_MIME_TYPE;
	return 'application/octet-stream';
}

/**
 * Whether this is an Excel workbook or a CSV file (006 FR-050). Only Auto
 * Import takes these, and only `extractDocumentSource` reads them: the other
 * extractors here read a PDF or a photo, as they always have.
 */
export function isSpreadsheetMimeType(mimeType: string): boolean {
	return mimeType === XLSX_MIME_TYPE || mimeType === CSV_MIME_TYPE;
}

/**
 * Whether the text read from this file is kept on its queue row and used again
 * when the same file is read once more: by "Read again", or after a restart
 * (006 FR-023). Only an image's, because:
 *
 * - an image is read by OCR, which is the slow part, and
 * - its text is the same whichever reading asks for it: the receipt reading
 *   takes it as it is, and a reading of items numbers its lines as one page,
 *   exactly as `extractNumberedText` and `extractPlainAndNumberedText` do.
 *
 * A PDF is not kept. A PDF with a text layer is quick to read again, and its
 * text differs by reading (merged for a receipt, page by page for items), so a
 * kept copy would not be what a fresh read gives. A scanned PDF is therefore
 * read by OCR again.
 */
export function keepsReadText(filename: string): boolean {
	const mimeType = inferMimeType(filename);
	return mimeType === 'image/jpeg' || mimeType === 'image/png';
}

export async function extractText(absPath: string, mimeType: string): Promise<string> {
	if (mimeType === 'application/pdf' || absPath.toLowerCase().endsWith('.pdf')) {
		return extractFromPdf(absPath);
	}
	if (
		mimeType === 'image/jpeg' ||
		mimeType === 'image/png' ||
		/\.(jpe?g|png)$/i.test(absPath)
	) {
		return extractFromImage(absPath);
	}
	throw new Error(`Unsupported file type. Please upload a PDF, JPG, or PNG.`);
}

async function extractFromPdf(absPath: string): Promise<string> {
	const buffer = readFileSync(absPath);
	const { text, totalPages } = await pdfExtractText(new Uint8Array(buffer), { mergePages: true });

	const avgCharsPerPage = totalPages > 0 ? text.length / totalPages : text.length;
	if (avgCharsPerPage < 50 && text.length < 200) {
		// Scanned PDF (no embedded text layer) — render each page to an image
		// and OCR that, since tesseract.js can't read PDF bytes directly.
		return extractFromScannedPdf(buffer, totalPages);
	}
	return text.trim();
}

// Encodes a decoded image's raw samples (1/3/4 channels) to a PNG buffer
// tesseract.js can read, expanding to RGBA. Uses pngjs (pure JS) instead of a
// native canvas so it runs on CPUs without AVX (e.g. low-power NAS hardware).
function imageObjectToPngBuffer(data: Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Buffer {
	const png = new PNG({ width, height });
	const out = png.data; // RGBA Buffer, length width * height * 4
	for (let i = 0, p = 0; p < width * height; i += channels, p++) {
		const o = p * 4;
		if (channels === 1) {
			out[o] = out[o + 1] = out[o + 2] = data[i];
		} else {
			out[o] = data[i];
			out[o + 1] = data[i + 1];
			out[o + 2] = data[i + 2];
		}
		out[o + 3] = channels === 4 ? data[i + 3] : 255;
	}
	return PNG.sync.write(png);
}

async function extractFromScannedPdf(buffer: Buffer, totalPages: number): Promise<string> {
	const pages = await ocrScannedPdfPages(buffer, totalPages);
	return pages.flat().join('\n').trim();
}

// OCRs every image of a scanned PDF (one with no text layer), since
// tesseract.js can't read PDF bytes directly. Returns, for each page, the text
// of each of its images in order.
async function ocrScannedPdfPages(buffer: Buffer, totalPages: number): Promise<string[][]> {
	const pdf = await getDocumentProxy(new Uint8Array(buffer));
	const worker = await createOcrWorker();
	try {
		const pages: string[][] = [];
		for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
			const images = await extractImages(pdf, pageNumber);
			const texts: string[] = [];
			for (const img of images) {
				const png = imageObjectToPngBuffer(img.data, img.width, img.height, img.channels);
				const { data } = await worker.recognize(png);
				texts.push(data.text.trim());
			}
			pages.push(texts);
		}
		return pages;
	} finally {
		await worker.terminate();
	}
}

async function extractFromImage(absPath: string): Promise<string> {
	const worker = await createOcrWorker();
	try {
		const { data } = await worker.recognize(absPath);
		return data.text.trim();
	} finally {
		await worker.terminate();
	}
}

// ── Numbered text, for reading a document line by line ─────────────────────
//
// The receipt reading above sends the text as one run with no line breaks,
// which is enough to find one total (006 FR-004 keeps it that way). A reading
// that proposes one record per line needs the lines themselves, so this path
// keeps each page's line breaks and numbers every line. The model then says
// which line each item came from (`source_line`), and the reviewer can find it.

/** Marks the start of a page in numbered text. */
export function pageMarker(pageNumber: number): string {
	return `--- page ${pageNumber} ---`;
}

/**
 * Joins a document's pages into numbered text: each page starts with its
 * marker line, and every line with text on it starts with its number, for
 * example `L0001│Service fee 10.00`. Numbers run on across pages, so a number
 * names one line of the whole document. Blank lines are left out and not
 * numbered. Nothing is cut: every line of every page is kept.
 */
export function numberDocumentLines(pages: readonly string[]): string {
	const out: string[] = [];
	let lineNumber = 0;
	pages.forEach((page, index) => {
		out.push(pageMarker(index + 1));
		for (const line of page.split(/\r\n|\r|\n/)) {
			const text = line.trimEnd();
			if (!text.trim()) continue;
			lineNumber++;
			out.push(`L${String(lineNumber).padStart(4, '0')}│${text}`);
		}
	});
	return out.join('\n');
}

/**
 * Numbered text back as plain text: the page markers dropped and each line's
 * number taken off, so what is left is only what the document prints. Used
 * where the text is kept to be searched, where "L0001" would be noise.
 */
export function stripLineNumbers(numbered: string): string {
	const markers = /^--- page \d+ ---$/;
	return numbered
		.split('\n')
		.filter((line) => !markers.test(line))
		.map((line) => line.replace(/^L\d+│/, ''))
		.join('\n');
}

/**
 * The document's text with its line breaks kept and every line numbered (see
 * `numberDocumentLines`), for the several-items reading. A text PDF is read a
 * page at a time; a scanned PDF and an image are read by OCR, and numbered the
 * same way.
 */
export async function extractNumberedText(absPath: string, mimeType: string): Promise<string> {
	return numberDocumentLines(await extractPages(absPath, mimeType));
}

async function extractPages(absPath: string, mimeType: string): Promise<string[]> {
	if (mimeType === 'application/pdf' || absPath.toLowerCase().endsWith('.pdf')) {
		const buffer = readFileSync(absPath);
		const { text: pages, totalPages } = await pdfExtractText(new Uint8Array(buffer), {
			mergePages: false
		});
		// The same test as the receipt path for a PDF with no text layer.
		const length = pages.reduce((sum, page) => sum + page.length, 0);
		const avgCharsPerPage = totalPages > 0 ? length / totalPages : length;
		if (avgCharsPerPage < 50 && length < 200) {
			const ocr = await ocrScannedPdfPages(buffer, totalPages);
			return ocr.map((texts) => texts.join('\n'));
		}
		return pages;
	}
	if (
		mimeType === 'image/jpeg' ||
		mimeType === 'image/png' ||
		/\.(jpe?g|png)$/i.test(absPath)
	) {
		return [await extractFromImage(absPath)];
	}
	throw new Error(`Unsupported file type. Please upload a PDF, JPG, or PNG.`);
}

/**
 * The document's text both ways at once, for Auto-detect (006 US9): `plain` is
 * exactly what `extractText` gives, for the receipt reading and for detection,
 * and `numbered` is what `extractNumberedText` gives, for a profile reading.
 * Which one is needed is known only after detection, so both are taken from one
 * pass over the file: an image or a scanned PDF is read by OCR once, never twice.
 *
 * A text PDF is parsed twice, once merged and once page by page, so the plain
 * text is the merged text `extractText` reads and never a copy of how the
 * library merges pages. Whether a PDF is scanned is decided by the receipt
 * path's own test, so the standard reading is exactly what it was.
 */
export async function extractPlainAndNumberedText(
	absPath: string,
	mimeType: string
): Promise<{ plain: string; numbered: string }> {
	if (mimeType === 'application/pdf' || absPath.toLowerCase().endsWith('.pdf')) {
		const buffer = readFileSync(absPath);
		const { text, totalPages } = await pdfExtractText(new Uint8Array(buffer), {
			mergePages: true
		});
		const avgCharsPerPage = totalPages > 0 ? text.length / totalPages : text.length;
		if (avgCharsPerPage < 50 && text.length < 200) {
			const pages = await ocrScannedPdfPages(buffer, totalPages);
			return {
				plain: pages.flat().join('\n').trim(),
				numbered: numberDocumentLines(pages.map((texts) => texts.join('\n')))
			};
		}
		const { text: pages } = await pdfExtractText(new Uint8Array(buffer), { mergePages: false });
		return { plain: text.trim(), numbered: numberDocumentLines(pages) };
	}
	if (
		mimeType === 'image/jpeg' ||
		mimeType === 'image/png' ||
		/\.(jpe?g|png)$/i.test(absPath)
	) {
		const text = await extractFromImage(absPath);
		return { plain: text, numbered: numberDocumentLines([text]) };
	}
	throw new Error(`Unsupported file type. Please upload a PDF, JPG, or PNG.`);
}

// ── Spreadsheets (006 S4.2) ────────────────────────────────────────────────

/**
 * A document's text in every form a reading may need, from one pass over the
 * file. `plain` is one run of text for the receipt reading and for detection,
 * and `numbered` is its lines numbered for a reading of items. A spreadsheet
 * also gives back its `workbook`, the cells themselves, so a reading that goes
 * by the columns can use them without reading the file again.
 */
export interface DocumentSource {
	plain: string;
	numbered: string;
	workbook?: Workbook;
}

/**
 * The document's text, in every form, from one pass over the file.
 *
 * A spreadsheet is read cell by cell and turned into text (FR-051): each sheet
 * is a page headed `Sheet: <name>`, each row one line with its cells joined by
 * ` | `, and the lines numbered as a PDF's are. `plain` is the same text
 * without the numbers and page markers, which is what a reading of items keeps
 * for search. A file that cannot be read fails with a reason that names the
 * problem, such as an old `.xls` or a password.
 *
 * A PDF or a photo gives what `extractPlainAndNumberedText` gives, unchanged.
 */
export async function extractDocumentSource(absPath: string, mimeType: string): Promise<DocumentSource> {
	if (!isSpreadsheetMimeType(mimeType)) return extractPlainAndNumberedText(absPath, mimeType);
	const workbook = readSpreadsheet(readFileSync(absPath), mimeType);
	return { ...spreadsheetText(workbook), workbook };
}

/** A spreadsheet's bytes as sheets of cells. */
export function readSpreadsheet(bytes: Uint8Array, mimeType: string): Workbook {
	return mimeType === XLSX_MIME_TYPE ? readXlsx(bytes) : readCsv(bytes);
}

/** A workbook as plain and numbered text (FR-051). */
export function spreadsheetText(workbook: Workbook): { plain: string; numbered: string } {
	const { pages } = renderWorkbook(workbook);
	return { plain: pages.join('\n'), numbered: numberDocumentLines(pages) };
}

/**
 * Whether no cell of the workbook shows anything, so its text would be no more
 * than the sheet names. Stops at the first cell that does.
 */
export function isEmptyWorkbook(workbook: Workbook): boolean {
	return workbook.sheets.every((sheet) => sheet.rows.every(isBlankRow));
}
