import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SubsyncarrPlusDatabase } from '../database';

describe('alass failure-tracking reset migration', () => {
  it('clears alass skips once and leaves other engines alone', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'subsyncarr-')), 'test.db');

    const first = new SubsyncarrPlusDatabase(file);
    first.recordEngineFailure('/a.srt', 'alass');
    first.recordEngineFailure('/a.srt', 'alass');
    first.recordEngineFailure('/a.srt', 'alass');
    first.recordEngineFailure('/a.srt', 'ffsubsync');
    first.recordEngineFailure('/a.srt', 'ffsubsync');
    first.recordEngineFailure('/a.srt', 'ffsubsync');
    first.close();

    // Simulate a database created before the migration existed.
    const raw = new Database(file);
    raw.pragma('user_version = 0');
    raw.close();

    const second = new SubsyncarrPlusDatabase(file);
    expect(second.getAllSkippedEngines('/a.srt')).toEqual(['ffsubsync']);
    // A new alass failure after the migration must count normally (not be wiped again).
    second.recordEngineFailure('/a.srt', 'alass');
    second.close();

    const third = new SubsyncarrPlusDatabase(file);
    expect(third.getEngineFailureTracking('/a.srt', 'alass')?.consecutive_failures).toBe(1);
    third.close();
  });
});
