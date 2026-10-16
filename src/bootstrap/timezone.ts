/**
 * Pins the process timezone to the business timezone BEFORE anything else runs.
 *
 * Much of the older code builds day keys and hour buckets with local-time Date
 * getters (getDate, getHours). On a UTC server those put every pre-05:30 IST
 * minute on the previous day and shift hourly charts by 5h30. Setting TZ here
 * makes all of it follow APP_TIMEZONE, and Node re-reads TZ when it is assigned.
 * New code uses the explicit helpers in shared/utils/timezone.ts.
 *
 * Imported first in main.ts, ahead of Nest and config loading.
 */
import { config as loadDotenv } from 'dotenv';
import { appTimezone } from '../shared/utils/timezone';

// APP_TIMEZONE may live only in .env, which ConfigModule reads later. Load it now
// (never overriding real environment variables) so the zone is right from line one.
loadDotenv();
process.env.TZ = appTimezone();
