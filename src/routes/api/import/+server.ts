import { json } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID, createHash } from 'crypto';
import { db } from '$lib/server/db/client.js';
import { importQueue } from '$lib/server/db/schema.js';
import { saveToTemp, MAX_UPLOAD_BYTES, releaseIfUnreferenced } from '$lib/server/file-storage.js';
import { importUploadNameRefusal, sniffImportUpload } from '$lib/server/import/upload-type.js';
import { importEvents } from '$lib/server/import/events.js';
import { jobForEvent } from '$lib/server/import/job-event.js';
import { jobEvents } from '$lib/server/import/group-state.js';
import { readingForUpload } from '$lib/server/import/upload-reading.js';
import { profileSnapshotOf, serializeProfileSnapshot } from '$lib/server/import/profile-snapshot.js';
import { deletedProfileName, getImportProfile } from '$lib/server/services/import-profiles.js';
import { ImportState } from '$lib/enums.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';
import { auditImportJob } from '$lib/server/import/audit.js';

const ACTIVE_STATES: number[] = [ImportState.Queued, ImportState.Extracting, ImportState.Processing];

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.read')) return new Response('Forbidden', { status: 403 });

	const activeOnly = url.searchParams.get('active') === '1';

	// Shared ledger — list every job, not just the caller's uploads.
	const rows = (
		activeOnly
			? db.select().from(importQueue).where(inArray(importQueue.state, ACTIVE_STATES))
			: db.select().from(importQueue)
	).all();

	// Sort: active first, then by createdAt desc
	rows.sort((a, b) => {
		const aActive = ACTIVE_STATES.includes(a.state) ? 0 : 1;
		const bActive = ACTIVE_STATES.includes(b.state) ? 0 : 1;
		if (aActive !== bActive) return aActive - bActive;
		return b.createdAt.localeCompare(a.createdAt);
	});

	// The same shape as a live update: no document text, which can be tens of
	// thousands of characters per row and which no screen reads from the list,
	// and each group with its item counts.
	return json(jobEvents(db, rows));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.create')) return new Response('Forbidden', { status: 403 });

	const formData = await request.formData();
	const file = formData.get('file');

	if (!(file instanceof File)) {
		return json({ error: 'No file provided' }, { status: 400 });
	}

	// How to read it (FR-001). Checked before anything is stored, so a refused
	// upload leaves no file and no queue row behind. A saved profile needs only
	// this upload permission, the same as every other way of reading (FR-045).
	// A profile is read in its own import mode (FR-002); an `importMode` field
	// sent by a screen opened before that choice was removed is not read.
	const reading = readingForUpload(
		formData.get('readAs'),
		(id) => getImportProfile(db, id),
		(id) => deletedProfileName(db, id)
	);
	if (!reading.ok) return json({ error: reading.error }, { status: 400 });

	// A copy of the chosen profile, taken now, so the queue can name it while
	// the document waits or if it fails, and the reading can still name it if
	// the profile is deleted first (FR-041). Reading replaces it with the
	// profile as it is then (FR-038).
	const chosenProfile = reading.profileId ? getImportProfile(db, Number(reading.profileId)) : null;
	const profileSnapshot = chosenProfile ? serializeProfileSnapshot(profileSnapshotOf(chosenProfile)) : null;

	// Optional: caller already ran its own OCR/extraction (e.g. Apple Vision Framework
	// via a client-side Shortcut) and wants the server to skip its own OCR.
	const MAX_EXTRACTED_TEXT_LENGTH = 50_000;
	const rawExtractedText = formData.get('extractedText');
	let preExtractedText: string | null = null;
	if (typeof rawExtractedText === 'string') {
		const trimmed = rawExtractedText.trim();
		if (trimmed.length > MAX_EXTRACTED_TEXT_LENGTH) {
			return json(
				{ error: `extractedText too long. Maximum length is ${MAX_EXTRACTED_TEXT_LENGTH} characters.` },
				{ status: 400 }
			);
		}
		if (trimmed.length > 0) preExtractedText = trimmed;
	}

	// A PDF, a photo, an Excel workbook or a CSV file (006 FR-050). Only Auto
	// Import takes spreadsheets; Reconciliation and record attachments do not.
	const nameRefusal = importUploadNameRefusal(file.name);
	if (nameRefusal) return json({ error: nameRefusal }, { status: 400 });

	if (file.size > MAX_UPLOAD_BYTES) {
		return json(
			{ error: `File too large. Maximum size is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` },
			{ status: 413 }
		);
	}

	const buffer = Buffer.from(await file.arrayBuffer());

	// Validate by content, not just the client-supplied name/MIME. A
	// spreadsheet's content must also match its name, since it is read by it.
	const sniffed = sniffImportUpload(buffer, file.name);
	if (!sniffed.ok) return json({ error: sniffed.error }, { status: 400 });

	const tempFilePath = await saveToTemp(buffer, file.name);
	const fileHash = createHash('sha256').update(buffer).digest('hex');

	const jobId = randomUUID();
	const userId = locals.user.id;
	try {
		db.transaction((tx) => {
			tx.insert(importQueue)
			.values({
				id: jobId,
				createdBy: userId,
				state: ImportState.Queued,
				tempFilePath,
				originalFilename: file.name,
				fileHash,
				preExtractedText,
				readAs: reading.readAs,
				readHow: reading.readHow,
				profileId: reading.profileId,
				profileSnapshot,
				importMode: reading.importMode
			})
			.run();
			auditImportJob(tx, {
				jobId,
				userId,
				action: 'create',
				changes: [
					{ field: 'originalFilename', before: null, after: file.name },
					{ field: 'readAs', before: null, after: reading.readAs },
					...(chosenProfile
						? [{ field: 'profile', before: null, after: chosenProfile.name }]
						: [])
				]
			});
		});
	} catch (e) {
		// No job points at the upload, so nothing would ever discard it.
		releaseIfUnreferenced(db, tempFilePath);
		throw e;
	}

	const newJob = db.select().from(importQueue).where(eq(importQueue.id, jobId)).get();
	if (newJob) importEvents.emit('job-update', { userId: locals.user.id, job: jobForEvent(newJob) });

	return json({ jobId }, { status: 202 });
};
