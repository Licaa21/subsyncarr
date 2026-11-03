import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findMatchingVideoFile } from '../findMatchingVideoFile';

describe('findMatchingVideoFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'subsyncarr-match-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeFiles(fileNames: string[]): Promise<void> {
    await Promise.all(fileNames.map((fileName) => writeFile(join(directory, fileName), '')));
  }

  it('matches a .ts video with the same base name', async () => {
    await writeFiles(['Show - S01E01.ts', 'Show - S01E01.srt']);

    expect(findMatchingVideoFile(join(directory, 'Show - S01E01.srt'))).toBe(join(directory, 'Show - S01E01.ts'));
  });

  it('matches a .ts video after removing language and flag tags', async () => {
    await writeFiles(['F1.ts', 'F1.en.hi.srt']);

    expect(findMatchingVideoFile(join(directory, 'F1.en.hi.srt'))).toBe(join(directory, 'F1.ts'));
  });

  it('still prefers .mkv when a .ts with the same name exists', async () => {
    await writeFiles(['Movie.mkv', 'Movie.ts', 'Movie.en.srt']);

    expect(findMatchingVideoFile(join(directory, 'Movie.en.srt'))).toBe(join(directory, 'Movie.mkv'));
  });
});
