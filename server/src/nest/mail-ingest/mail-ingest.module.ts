import { Module } from '@nestjs/common';
import { BookingImportModule } from '../booking-import/booking-import.module';
import { MailIngestController } from './mail-ingest.controller';
import { MailIngestService } from './mail-ingest.service';

@Module({
  imports: [BookingImportModule],
  controllers: [MailIngestController],
  providers: [MailIngestService],
  exports: [MailIngestService],
})
export class MailIngestModule {}
