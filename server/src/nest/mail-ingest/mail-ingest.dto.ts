/**
 * Server-side createZodDto wrappers over the @trek/shared mail-ingest
 * contracts, so the global ZodValidationPipe (APP_PIPE) validates bodies by
 * metatype — the shared Zod schemas stay the single source of truth.
 */
import { createZodDto } from 'nestjs-zod';
import { mailIngestSourceEnabledSchema, mailIngestSourceSchema } from '@trek/shared';

/** POST sources / POST sources/test — both take the same IMAP source shape. */
export class MailIngestSourceDto extends createZodDto(mailIngestSourceSchema) {}

/** PATCH sources/:id — the only mutable field is the enabled toggle. */
export class MailIngestSourceEnabledDto extends createZodDto(mailIngestSourceEnabledSchema) {}
