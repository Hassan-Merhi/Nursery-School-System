create sequence if not exists family_number_seq;
create sequence if not exists student_number_seq;

create table if not exists family (
  id uuid primary key default gen_random_uuid(),
  family_number text not null unique default ('FAM-' || lpad(nextval('family_number_seq')::text, 5, '0')),
  display_name text not null,
  home_phone text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null
);
create index if not exists family_display_name_ci_idx on family(lower(display_name));

create table if not exists guardian (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text,
  phone text not null,
  alternate_phone text,
  address text,
  occupation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null
);
create index if not exists guardian_name_idx on guardian(lower(last_name), lower(first_name));

create table if not exists family_guardian (
  family_id uuid not null references family(id) on delete restrict,
  guardian_id uuid not null references guardian(id) on delete restrict,
  relationship text not null,
  is_primary boolean not null default false,
  has_legal_custody boolean not null default true,
  pickup_authorized boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  primary key (family_id, guardian_id)
);
create unique index if not exists one_primary_guardian_per_family
  on family_guardian(family_id) where is_primary;

create table if not exists student (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references family(id) on delete restrict,
  student_number text not null unique default ('STU-' || lpad(nextval('student_number_seq')::text, 5, '0')),
  first_name text not null,
  last_name text not null,
  preferred_name text,
  date_of_birth date not null,
  gender text check (gender is null or gender in ('female','male','other','unspecified')),
  nationality text,
  status text not null default 'prospective'
    check (status in ('prospective','active','withdrawn','inactive','graduated')),
  admission_date date,
  exit_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  check (exit_date is null or admission_date is null or exit_date >= admission_date)
);
create unique index if not exists student_id_family_unique on student(id, family_id);
create index if not exists student_family_idx on student(family_id);
create index if not exists student_name_idx on student(lower(last_name), lower(first_name));
create index if not exists student_status_idx on student(status);

create or replace view student_sibling_relationship as
select
  a.id as student_id,
  b.id as sibling_id,
  a.family_id
from student a
join student b on b.family_id=a.family_id and b.id<>a.id;

create table if not exists emergency_contact (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid,
  full_name text not null,
  relationship text not null,
  phone text not null,
  alternate_phone text,
  notes text,
  priority smallint not null default 1 check (priority between 1 and 9),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  foreign key (student_id, family_id) references student(id, family_id) on delete restrict
);
create index if not exists emergency_contact_family_idx on emergency_contact(family_id, priority);
create index if not exists emergency_contact_student_idx on emergency_contact(student_id, priority);

create table if not exists school_class (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references school_year(id) on delete restrict,
  name text not null,
  room text,
  lead_teacher text,
  capacity integer check (capacity is null or capacity > 0),
  status text not null default 'active' check (status in ('planned','active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  unique (school_year_id, name)
);
create unique index if not exists school_class_id_year_unique on school_class(id, school_year_id);

create table if not exists student_enrollment (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references student(id) on delete restrict,
  school_year_id uuid not null references school_year(id) on delete restrict,
  class_id uuid not null,
  status text not null default 'enrolled'
    check (status in ('enrolled','withdrawn','completed','cancelled')),
  enrolled_on date not null default current_date,
  starts_on date not null,
  withdrawal_on date,
  withdrawal_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  foreign key (class_id, school_year_id)
    references school_class(id, school_year_id) on delete restrict,
  check (withdrawal_on is null or withdrawal_on >= starts_on)
);
create unique index if not exists student_enrollment_id_year_unique
  on student_enrollment(id, school_year_id);
create unique index if not exists one_open_enrollment_per_student_year
  on student_enrollment(student_id, school_year_id)
  where status='enrolled';
create index if not exists student_enrollment_student_idx
  on student_enrollment(student_id, school_year_id);
create index if not exists student_enrollment_class_idx
  on student_enrollment(class_id, status);

create unique index if not exists school_term_id_year_unique
  on school_term(id, school_year_id);

create table if not exists student_term_enrollment (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null,
  school_year_id uuid not null,
  term_id uuid not null,
  status text not null default 'enrolled'
    check (status in ('enrolled','withdrawn','completed','cancelled')),
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  foreign key (enrollment_id, school_year_id)
    references student_enrollment(id, school_year_id) on delete restrict,
  foreign key (term_id, school_year_id)
    references school_term(id, school_year_id) on delete restrict,
  unique (enrollment_id, term_id),
  check (ends_on >= starts_on)
);
create index if not exists student_term_enrollment_term_idx
  on student_term_enrollment(term_id, status);

create table if not exists student_document (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references student(id) on delete restrict,
  document_id uuid not null references stored_document(id) on delete restrict,
  document_type text not null,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (student_id, document_id)
);
create index if not exists student_document_student_idx on student_document(student_id, created_at desc);

create table if not exists student_history (
  id bigint generated always as identity primary key,
  student_id uuid not null references student(id) on delete restrict,
  enrollment_id uuid references student_enrollment(id) on delete restrict,
  event_type text not null,
  event_date date not null default current_date,
  summary text not null,
  details jsonb,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references app_user(id) on delete set null
);
create index if not exists student_history_student_idx
  on student_history(student_id, occurred_at desc, id desc);

create or replace function prevent_student_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'student_history is append-only';
end;
$$;

drop trigger if exists student_history_immutable on student_history;
create trigger student_history_immutable
before update or delete on student_history
for each row
execute function prevent_student_history_mutation();

insert into permission(key, description) values
  ('families.view', 'View families, guardians, and emergency contacts'),
  ('families.manage', 'Create and update families, guardians, and emergency contacts'),
  ('students.view', 'View student profiles and sibling relationships'),
  ('students.manage', 'Create students and update student status'),
  ('classes.view', 'View classes'),
  ('classes.manage', 'Create and update classes'),
  ('enrollments.view', 'View student and term enrollments'),
  ('enrollments.manage', 'Create enrollments and process withdrawals'),
  ('student_documents.view', 'View documents attached to student records'),
  ('student_documents.manage', 'Upload documents to student records'),
  ('student_history.view', 'View append-only student history')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id, permission_key)
select r.id, p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
