/**
 * Mail-ingest controller e2e (Task 4 — Zod body contracts).
 *
 * Exercises the real global ZodValidationPipe + TrekExceptionFilter against
 * the real MailIngestController and its mail-ingest.dto.ts wrappers, the same
 * way todo.e2e.test.ts proves the pipe for TodoController. MailIngestService
 * is mocked (its own behaviour is covered by mail-ingest.e2e.test.ts), so this
 * suite is scoped to exactly what Task 4 owns: does a well-formed body reach
 * the service, and does a body missing a required field get rejected with
 * TREK's standard `{ error }` 400 envelope — without ever booting the full
 * AppModule (see the boot-gate test below for why that matters here).
 *
 * This file also doubles as the boot-gate proof for MailIngestController:
 * validateBodyContracts() is run directly against the built testing app, on
 * the real controller class (not a synthetic stand-in), scoped to just this
 * module's routes (empty allow-list — see the test for why).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { MailIngestController } from '../../src/nest/mail-ingest/mail-ingest.controller';
import { MailIngestService } from '../../src/nest/mail-ingest/mail-ingest.service';
import { MailIngestAddonGuard } from '../../src/nest/mail-ingest/mail-ingest-addon.guard';
import { JwtAuthGuard } from '../../src/nest/auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../src/nest/common/zod-validation.pipe';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';
import { validateBodyContracts } from '../../src/nest/common/validate-body-contracts';

const authedUser = { id: 1, role: 'user', email: 'u@example.test' };

describe('MailIngestController e2e (real ZodValidationPipe, mocked service)', () => {
  let app: INestApplication;
  let server: Server;

  const addSource = vi.fn();
  const testConfig = vi.fn();
  const setEnabled = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MailIngestController],
      providers: [
        {
          provide: MailIngestService,
          useValue: {
            listSources: vi.fn(),
            listActivity: vi.fn(),
            addSource,
            testConfig,
            deleteSource: vi.fn(),
            setEnabled,
            catchUp: vi.fn(),
          },
        },
      ],
    })
      // The addon gate itself (Fix 1) is covered end-to-end by
      // mail-ingest-addon.e2e.test.ts against the REAL guard; neutralize it
      // here so this suite stays scoped to the Zod body-contract behaviour it
      // already owned before that guard existed.
      .overrideGuard(MailIngestAddonGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = authedUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror the production APP_PIPE (app.module.ts) so DTO-typed bodies
    // validate by metatype exactly as they do under buildApp().
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new TrekExceptionFilter());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // Not run through the standard bootstrap.test.ts (BOOT-*) suite, which boots
  // the full AppModule via buildApp(): on this checkout that transitively hits
  // an unrelated, pre-existing bug in server/vitest.config.ts's `@trek/nest-mcp`
  // alias (`new URL(...).pathname` mis-decodes the Windows path because the
  // repo lives under "Michael Bohr", a directory name with a space — verified
  // by running an untouched integration test, tests/integration/categories.test.ts,
  // which fails identically with zero mail-ingest changes present). That bug is
  // out of scope for Task 4 (unrelated file, unrelated cause). This test proves
  // the same thing buildApp()'s validateBodyContracts(app) call would prove for
  // MailIngestController specifically: it runs the REAL gate against the REAL
  // controller class discovered by Nest's ModulesContainer. The allow-list is
  // passed empty (not the real BODY_CONTRACT_ALLOW_LIST) because this testing
  // module only contains MailIngestController — every other app route the real
  // list references would register as a "stale" entry here, which is a
  // property of the real full app graph and already covered by GATE-006 in
  // validate-body-contracts.test.ts, not something this scoped module can
  // meaningfully assert either way.
  it('BOOT-GATE — MailIngestController has zero unvalidated @Body() handlers', () => {
    expect(() => validateBodyContracts(app, [])).not.toThrow();
  });

  const validBody = { host: 'imap.example.com', username: 'me@example.com', password: 'hunter2' };

  describe('POST /api/mail-ingest/sources', () => {
    it('201 on a valid body, forwarded to the service as-is', async () => {
      addSource.mockResolvedValue({ id: 1, host: validBody.host, username: validBody.username });
      const res = await request(server).post('/api/mail-ingest/sources').send(validBody);
      expect(res.status).toBe(201);
      expect(addSource).toHaveBeenCalledWith(1, expect.objectContaining(validBody));
    });

    it('accepts the optional port/folder/poll_interval_minutes fields', async () => {
      addSource.mockResolvedValue({ id: 2 });
      const res = await request(server)
        .post('/api/mail-ingest/sources')
        .send({ ...validBody, port: 143, folder: 'Archive', poll_interval_minutes: 15 });
      expect(res.status).toBe(201);
      expect(addSource).toHaveBeenCalledWith(1, expect.objectContaining({ port: 143, folder: 'Archive', poll_interval_minutes: 15 }));
    });

    it('400 from the Zod pipe when host/username/password are missing, without reaching the service', async () => {
      addSource.mockClear();
      const res = await request(server).post('/api/mail-ingest/sources').send({ password: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('host');
      expect(res.body.error).toContain('username');
      expect(addSource).not.toHaveBeenCalled();
    });

    it('400 when a required field is blank after trimming', async () => {
      const res = await request(server).post('/api/mail-ingest/sources').send({ ...validBody, host: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('host');
    });

    it('400 when port is outside the valid TCP range', async () => {
      const res = await request(server).post('/api/mail-ingest/sources').send({ ...validBody, port: 99999 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('port');
    });
  });

  describe('POST /api/mail-ingest/sources/test', () => {
    it('201 on a valid body', async () => {
      testConfig.mockResolvedValue({ ok: true });
      const res = await request(server).post('/api/mail-ingest/sources/test').send(validBody);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
      expect(testConfig).toHaveBeenCalledWith(expect.objectContaining(validBody));
    });

    it('400 from the Zod pipe when password is missing', async () => {
      testConfig.mockClear();
      const res = await request(server)
        .post('/api/mail-ingest/sources/test')
        .send({ host: validBody.host, username: validBody.username });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('password');
      expect(testConfig).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/mail-ingest/sources/:id', () => {
    it('200 with a boolean enabled', async () => {
      setEnabled.mockReturnValue(true);
      const res = await request(server).patch('/api/mail-ingest/sources/9').send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(setEnabled).toHaveBeenCalledWith(1, '9', true);
    });

    it('200 with enabled omitted (defaults falsy)', async () => {
      setEnabled.mockReturnValue(true);
      const res = await request(server).patch('/api/mail-ingest/sources/9').send({});
      expect(res.status).toBe(200);
      expect(setEnabled).toHaveBeenCalledWith(1, '9', false);
    });

    it('400 from the Zod pipe when enabled is not a boolean', async () => {
      setEnabled.mockClear();
      const res = await request(server).patch('/api/mail-ingest/sources/9').send({ enabled: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('enabled');
      expect(setEnabled).not.toHaveBeenCalled();
    });
  });
});
