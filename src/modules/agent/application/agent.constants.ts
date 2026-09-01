/** Marks the end of the exe and the start of the embedded per-user config. */
export const TRAILER_MAGIC = 'TCAGCFG1';

/**
 * What the browser saves the download as. Only the name offered to the user — the
 * object in S3 keeps its own key, so renaming here needs no storage or env change.
 */
export const DEFAULT_ZIP_FILE_NAME = 'RXVision.zip';
export const DEFAULT_EXE_FILE_NAME = 'RXVision.exe';
