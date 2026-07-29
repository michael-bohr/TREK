/**
 * Mail-ingest addon gate e2e — exercises MailIngestController through the REAL
 * JwtAuthGuard and the REAL MailIngestAddonGuard against a temp SQLite `users`
 * table, the same way journey.e2e.test.ts and collections.e2e.test.ts prove
 * their addon gates. MailIngestService is mocked (its own behaviour is covered
 * by mail-ingest.e2e.test.ts and the Zod-pipe coverage in
 * mail-ingest.controller.e2e.test.ts), so this suite is scoped to exactly what
 * Fix 1 owns: with the `mail_ingest` addon disabled, every route in the group
 * — including a deep one — answers 404 (addon gate wins over the 401 a missing
 * cookie would otherwise produce), and with the addon enabled the group is
 * reachable again (401 without a cookie, 200/201 with one).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { seedUser, sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  tmp.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0);`);
  return { db: tmp };
});

vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

const { isAddonEnabled } = vi.hoisted(() => ({ isAddonEnabled: vi.fn(() => true) }));
vi.mock('../../src/services/adminService', () => ({ isAddonEnabled }));

const { listSources, addSource } = vi.hoisted(() => ({
  listSources: vi.fn().mockReturnValue([]),
  addSource: vi.fn().mockResolvedValue({ id: 1, host: 'imap.example.com', username: 'me@example.com' }),
}));

import { MailIngestController } from '../../src/nest/mail-ingest/mail-ingest.controller';
import { MailIngestService } from '../../src/nest/mail-ingest/mail-ingest.service';
import { JwtAuthGuard } from '../../src/nest/auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../src/nest/common/zod-validation.pipe';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';

describe('Mail-ingest addon gate e2e (real auth guard + real addon guard)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;

  async function build() {
    const moduleRef = await Test.createTestingModule({
      controllers: [MailIngestController],
      providers: [
        {
          provide: MailIngestService,
          useValue: {
            listSources,
            listActivity: vi.fn().mockReturnValue([]),
            addSource,
            testConfig: vi.fn(),
            deleteSource: vi.fn(),
            setEnabled: vi.fn(),
            catchUp: vi.fn().mockResolvedValue({ imported: 0, pending: 0, skipped: 0, errored: 0 }),
          },
        },
      ],
    }).compile();
    // JwtAuthGuard is NOT overridden here — the real guard runs, so the 404
    // (addon)-vs-401 (auth) ordering test below exercises the real precedence,
    // exactly as journey.e2e.test.ts / collections.e2e.test.ts do for their guards.
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    nest.useGlobalPipes(new ZodValidationPipe());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    seedUser(db as never, { id: 1 });
    app = await build();
    server = app.getHttpServer();
  });

  beforeEach(() => {
    isAddonEnabled.mockReturnValue(true);
    listSources.mockClear();
    addSource.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('404 (addon gate wins over auth) on GET /sources when the addon is disabled, no cookie', async () => {
    isAddonEnabled.mockReturnValue(false);
    const res = await request(server).get('/api/mail-ingest/sources');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Mail ingest addon is not enabled' });
    expect(listSources).not.toHaveBeenCalled();
  });

  it('404 on a deep route (catch-up) too when the addon is disabled', async () => {
    isAddonEnabled.mockReturnValue(false);
    const res = await request(server).post('/api/mail-ingest/sources/1/catch-up');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Mail ingest addon is not enabled' });
  });

  it('404 on POST /sources when disabled, even with a valid session (addon gate is unconditional)', async () => {
    isAddonEnabled.mockReturnValue(false);
    const res = await request(server)
      .post('/api/mail-ingest/sources')
      .set('Cookie', sessionCookie(1))
      .send({ host: 'imap.example.com', username: 'me@example.com', password: 'hunter2' });
    expect(res.status).toBe(404);
    expect(addSource).not.toHaveBeenCalled();
  });

  it('401 with the addon enabled but no session cookie', async () => {
    const res = await request(server).get('/api/mail-ingest/sources');
    expect(res.status).toBe(401);
  });

  it('200 with the addon enabled and a valid session — reaches the service', async () => {
    const res = await request(server).get('/api/mail-ingest/sources').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(listSources).toHaveBeenCalledWith(1);
  });

  it('201 on POST /sources with the addon enabled and a valid session', async () => {
    const res = await request(server)
      .post('/api/mail-ingest/sources')
      .set('Cookie', sessionCookie(1))
      .send({ host: 'imap.example.com', username: 'me@example.com', password: 'hunter2' });
    expect(res.status).toBe(201);
    expect(addSource).toHaveBeenCalledWith(1, expect.objectContaining({ host: 'imap.example.com' }));
  });
});
