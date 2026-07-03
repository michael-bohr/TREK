export interface EmailStrings {
  footer: string;
  manage: string;
  madeWith: string;
  openTrek: string;
}

export interface EventText {
  title: string;
  body: string;
}

export type EventTextFn = (params: Record<string, string>) => EventText;

export interface PasswordResetStrings {
  subject: string;
  greeting: string;
  body: string;
  ctaIntro: string;
  expiry: string;
  ignore: string;
}

export type RequiredNotificationEventKey =
  | 'trip_invite'
  | 'booking_change'
  | 'trip_reminder'
  | 'todo_due'
  | 'vacay_invite'
  | 'collection_invite'
  | 'photos_shared'
  | 'collab_message'
  | 'packing_tagged'
  | 'version_available'
  | 'synology_session_cleared';

/** Events a locale MAY translate; missing entries fall back to English at the
 *  call site (getEventText). Lets new in-app-only events ship with an English
 *  string without touching every locale file. */
export type OptionalNotificationEventKey = 'mail_ingest_imported' | 'mail_ingest_pending';

export type NotificationEventKey = RequiredNotificationEventKey | OptionalNotificationEventKey;

export interface NotificationLocale {
  email: EmailStrings;
  events: Record<RequiredNotificationEventKey, EventTextFn> & Partial<Record<OptionalNotificationEventKey, EventTextFn>>;
  passwordReset: PasswordResetStrings;
}
