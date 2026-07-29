import { CanActivate, HttpException, Injectable } from '@nestjs/common';
import { isAddonEnabled } from '../../services/adminService';
import { ADDON_IDS } from '../../addons';

/**
 * Gates the mail-ingest routes on the global `mail_ingest` addon. When the
 * admin has it disabled the whole group answers 404. Declared before the
 * JwtAuthGuard so the addon check wins over the 401 (same ordering as the
 * AirTrail addon gate).
 */
@Injectable()
export class MailIngestAddonGuard implements CanActivate {
  canActivate(): boolean {
    if (!isAddonEnabled(ADDON_IDS.MAIL_INGEST)) {
      throw new HttpException({ error: 'Mail ingest addon is not enabled' }, 404);
    }
    return true;
  }
}
