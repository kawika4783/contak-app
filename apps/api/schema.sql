CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(32) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  email varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  phone varchar(32),
  hometown varchar(120),
  about_me varchar(1000),
  profile_image_path text,
  profile_visibility varchar(8) NOT NULL DEFAULT 'private' CHECK (profile_visibility IN ('private', 'public')),
  search_by_email boolean NOT NULL DEFAULT false,
  search_by_phone boolean NOT NULL DEFAULT false,
  search_by_name boolean NOT NULL DEFAULT false,
  profile_updated_at timestamptz NOT NULL DEFAULT now(),
  suspended_until timestamptz,
  suspension_reason varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role varchar(16) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason varchar(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS hometown varchar(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS about_me varchar(1000);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_path text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_visibility varchar(8) NOT NULL DEFAULT 'private';
ALTER TABLE users ADD COLUMN IF NOT EXISTS search_by_email boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS search_by_phone boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS search_by_name boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_suspended_until_idx ON users (suspended_until);

CREATE TABLE IF NOT EXISTS contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX IF NOT EXISTS contact_requests_to_status_idx ON contact_requests (to_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_user_id),
  CHECK (user_id <> contact_user_id)
);
CREATE INDEX IF NOT EXISTS contacts_contact_user_idx ON contacts (contact_user_id, user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(20) NOT NULL DEFAULT 'one_to_one' CHECK (kind = 'one_to_one'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_participants_user_idx ON conversation_participants (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  message_type varchar(16) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'file')),
  attachment_path text,
  attachment_name varchar(255),
  attachment_mime varchar(120),
  attachment_size integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type varchar(16) NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_path text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name varchar(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime varchar(120);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size integer;
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  read_at timestamptz,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode varchar(16) NOT NULL DEFAULT 'on' CHECK (mode IN ('on', 'silent', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS call_history (
  id uuid PRIMARY KEY,
  caller_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(8) NOT NULL CHECK (kind IN ('audio', 'video')),
  status varchar(16) NOT NULL DEFAULT 'calling' CHECK (status IN ('calling', 'answered', 'ended', 'missed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  CHECK (caller_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS call_history_caller_created_idx ON call_history (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_history_recipient_created_idx ON call_history (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  reason varchar(120) NOT NULL,
  details text,
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (reporter_id <> reported_user_id)
);
CREATE INDEX IF NOT EXISTS reports_status_created_idx ON reports (status, created_at DESC);
