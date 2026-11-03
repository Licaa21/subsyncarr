import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SubsyncarrPlusDatabase } from '../database';

describe('retention cleanup', () => {
  it('keeps a running run when RETENTION_KEEP_RUNS_DAYS=0 but deletes finished ones', () => {
    const db = new SubsyncarrPlusDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'subsyncarr-')), 't.db'));
    db.createRun('active', 5);
    db.createRun('done', 5);
    db.updateRun('done', { status: 'completed' });

    // keepDays=0 means "cutoff = now"; wait a tick so both runs are older than the cutoff.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }

    expect(db.deleteOldRuns(0)).toBe(1);
    expect(db.getRun('active')).not.toBeNull();
    expect(db.getRun('done')).toBeNull();
    expect(db.getActiveRunIds()).toEqual(['active']);
    db.close();
  });
});
