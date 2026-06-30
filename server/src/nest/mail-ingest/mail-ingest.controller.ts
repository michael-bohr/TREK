import { Body, Controller, Delete, Get, HttpException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { User } from '../../types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MailIngestService, type MailSourceInput } from './mail-ingest.service';

/**
 * Per-user mail-source management + the manual "Catch up" trigger. Polling itself
 * runs on the scheduler tick (startMailIngest), not here.
 */
@Controller('api/mail-ingest')
@UseGuards(JwtAuthGuard)
export class MailIngestController {
  constructor(private readonly mailIngest: MailIngestService) {}

  @Get('sources')
  list(@CurrentUser() user: User) {
    return this.mailIngest.listSources(user.id);
  }

  @Post('sources')
  async add(@CurrentUser() user: User, @Body() body: MailSourceInput) {
    this.validate(body);
    try {
      return await this.mailIngest.addSource(user.id, body);
    } catch (err) {
      throw new HttpException({ error: `Could not connect: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  }

  @Post('sources/test')
  test(@Body() body: MailSourceInput) {
    this.validate(body);
    return this.mailIngest.testConfig(body);
  }

  @Delete('sources/:id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    if (!this.mailIngest.deleteSource(user.id, id)) throw new HttpException({ error: 'Not found' }, 404);
    return { ok: true };
  }

  @Patch('sources/:id')
  setEnabled(@CurrentUser() user: User, @Param('id') id: string, @Body() body: { enabled?: boolean }) {
    if (!this.mailIngest.setEnabled(user.id, id, !!body?.enabled)) throw new HttpException({ error: 'Not found' }, 404);
    return { ok: true };
  }

  @Post('sources/:id/catch-up')
  async catchUp(@CurrentUser() user: User, @Param('id') id: string, @Query('days') days?: string) {
    const d = Math.min(365, Math.max(1, Number(days) || 30));
    try {
      return await this.mailIngest.catchUp(user.id, id, d);
    } catch (err) {
      throw new HttpException({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  private validate(body: MailSourceInput): void {
    if (!body?.host || !body?.username || !body?.password) {
      throw new HttpException({ error: 'host, username and password are required' }, 400);
    }
  }
}
