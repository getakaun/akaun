import { env } from '$env/dynamic/private';

export const DATABASE_PATH = env['DATABASE_PATH'] || './data/akaun.db';
export const STORAGE_PATH = env['STORAGE_PATH'] || './data/storage';

/**
 * Where tesseract.js caches its downloaded `*.traineddata` language files.
 * Without an explicit path it writes them into the process CWD, which is the
 * repo root in dev (they were once committed by accident) and the app payload
 * dir in the Docker image. Keeping them under the storage dir puts
 * them on the same writable volume as everything else the app downloads.
 */
export const OCR_CACHE_PATH = `${STORAGE_PATH}/ocr-cache`;
