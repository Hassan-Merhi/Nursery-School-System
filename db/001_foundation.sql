create extension if not exists pgcrypto;

create table if not exists school_profile (
  id smallint primary key default 1 check (id = 1),
  name text not null default 'Montikids Montessori Preschool & Nursery',
  legal_name text,
  email text,
  phone text,
  address text,
  timezone text not null default 'Asia/Beirut',
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null
);
create unique index if not exists app_user_email_ci on app_user(lower(email));

alter table school_profile
  drop constraint if exists school_profile_updated_by_fkey;
alter table school_profile
  add constraint school_profile_updated_by_fkey
  foreign key (updated_by) references app_user(id) on delete set null;

create table if not exists permission (
  key text primary key,
  description text not null
);

create table if not exists role (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create unique index if not exists role_name_ci on role(lower(name));

create table if not exists role_permission (
  role_id uuid not null references role(id) on delete cascade,
  permission_key text not null references permission(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists user_role (
  user_id uuid not null references app_user(id) on delete cascade,
  role_id uuid not null references role(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references app_user(id) on delete set null,
  primary key (user_id, role_id)
);

create table if not exists user_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  user_agent text,
  ip_address inet
);
create index if not exists user_session_active_idx
  on user_session(user_id, expires_at)
  where revoked_at is null;

create table if not exists school_year (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'planned' check (status in ('planned','current','closed')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (ends_on > starts_on)
);
create unique index if not exists one_current_school_year
  on school_year(status) where status = 'current';

create table if not exists school_term (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references school_year(id) on delete cascade,
  sequence smallint not null check (sequence between 1 and 3),
  name text not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  unique (school_year_id, sequence),
  check (ends_on >= starts_on)
);

create table if not exists app_setting (
  key text primary key,
  category text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create table if not exists document_sequence (
  document_type text primary key,
  prefix text not null,
  next_number bigint not null default 1 check (next_number > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create table if not exists stored_document (
  id uuid primary key default gen_random_uuid(),
  storage_key text not null unique,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references app_user(id) on delete set null
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references app_user(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  occurred_at timestamptz not null default now(),
  ip_address inet,
  user_agent text
);
create index if not exists audit_log_occurred_idx on audit_log(occurred_at desc);
create index if not exists audit_log_entity_idx on audit_log(entity_type, entity_id);

insert into school_profile(id) values (1) on conflict (id) do nothing;

insert into permission(key, description) values
  ('dashboard.view', 'View the dashboard'),
  ('school_profile.view', 'View school profile'),
  ('school_profile.manage', 'Edit school profile'),
  ('school_years.view', 'View school years and terms'),
  ('school_years.manage', 'Create and manage school years and terms'),
  ('users.view', 'View users'),
  ('users.manage', 'Create and manage users'),
  ('roles.view', 'View roles and permissions'),
  ('roles.manage', 'Create roles and assign permissions'),
  ('settings.view', 'View system settings'),
  ('settings.manage', 'Edit system settings and document numbering'),
  ('documents.view', 'View stored document metadata'),
  ('documents.manage', 'Upload documents'),
  ('audit.view', 'View audit log')
on conflict (key) do update set description = excluded.description;

insert into role(name, description, is_system)
values
  ('Administrator', 'Full system access. Permissions are synchronized by migrations.', true),
  ('Staff', 'Basic signed-in access. Add permissions as required.', false)
on conflict do nothing;

insert into role_permission(role_id, permission_key)
select r.id, p.key
from role r cross join permission p
where lower(r.name) = 'administrator'
on conflict do nothing;

insert into role_permission(role_id, permission_key)
select r.id, p.key
from role r join permission p on p.key = 'dashboard.view'
where lower(r.name) = 'staff'
on conflict do nothing;

insert into app_setting(key, category, value) values
  ('currency', 'regional', '"USD"'::jsonb),
  ('number_locale', 'regional', '"en-US"'::jsonb),
  ('timezone', 'regional', '"Asia/Beirut"'::jsonb),
  ('storage_provider', 'storage', '"local"'::jsonb),
  ('backup_strategy', 'operations', '{"database":"daily pg_dump","documents":"daily filesystem snapshot","retention_days":30}'::jsonb)
on conflict (key) do nothing;

insert into document_sequence(document_type, prefix) values
  ('receipt', 'REC'),
  ('invoice', 'INV'),
  ('rental', 'RNT')
on conflict (document_type) do nothing;
