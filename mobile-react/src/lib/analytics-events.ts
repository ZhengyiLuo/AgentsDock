export type AnalyticsEvent =
  | 'app_launched'
  | 'terminal_opened'
  | 'file_view_opened'
  | 'job_schedule_opened'
  | 'chat_created'
  | 'chat_opened'
  | 'message_sent'
  | 'digest_opened'
  | 'search_opened'
  | 'open_file_clicked'
  | 'connection_tested'
  | 'server_added'
  | 'server_switched'

export type AnalyticsEventProps = { success?: boolean }
