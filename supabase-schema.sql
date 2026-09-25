create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  school_group text not null check (school_group in ('L', 'M', 'N', 'Autre')),
  gender text not null check (gender in ('Homme', 'Femme')),
  avatar text,
  created_at timestamptz not null default now()
);

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  school_group text not null check (school_group in ('L', 'M', 'N', 'Autre')),
  start_date date not null,
  end_date date not null,
  capacity integer not null check (capacity between 2 and 12),
  gender_rule text not null check (gender_rule in ('Mixte', 'Hommes seulement', 'Femmes seulement')),
  budget integer,
  city text not null,
  contact text not null,
  notes text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

alter table groups alter column start_date drop not null;
alter table groups alter column end_date drop not null;
alter table groups add column if not exists available_spots integer;
update groups
set available_spots = capacity
where available_spots is null;
alter table groups alter column available_spots set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'groups_available_spots_check'
  ) then
    alter table groups
      add constraint groups_available_spots_check
      check (available_spots >= 0 and available_spots <= capacity);
  end if;
end;
$$;

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, profile_id)
);

create table if not exists group_people (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  first_name text not null,
  school_group text not null check (school_group in ('L', 'M', 'N', 'Autre')),
  avatar text,
  is_creator boolean not null default false,
  created_at timestamptz not null default now()
);

insert into group_people (group_id, first_name, school_group, avatar, is_creator)
select groups.id, profiles.first_name, profiles.school_group, profiles.avatar, true
from groups
join profiles on profiles.id = groups.creator_id
where not exists (
  select 1
  from group_people
  where group_people.group_id = groups.id
    and group_people.is_creator = true
);

drop function if exists create_coloc_group(
  uuid,
  text,
  text,
  date,
  date,
  integer,
  text,
  integer,
  text,
  text,
  text
);

drop function if exists create_coloc_group(
  uuid,
  text,
  integer,
  text,
  text,
  text,
  text
);

drop function if exists create_coloc_group(
  uuid,
  text,
  integer,
  integer,
  text,
  text,
  text,
  text
);

drop function if exists create_coloc_group(
  uuid,
  text,
  integer,
  integer,
  text,
  text,
  text,
  text,
  jsonb
);

drop function if exists update_coloc_group(
  uuid,
  uuid,
  text,
  integer,
  integer,
  text,
  text,
  text,
  text
);

drop function if exists update_coloc_group(
  uuid,
  uuid,
  text,
  integer,
  integer,
  text,
  text,
  text,
  text,
  jsonb
);

drop function if exists join_coloc_group(uuid, uuid);

create or replace function create_coloc_group(
  p_creator_id uuid,
  p_school_group text,
  p_capacity integer,
  p_available_spots integer,
  p_gender_rule text,
  p_city text,
  p_contact text,
  p_notes text,
  p_existing_people jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_profile profiles%rowtype;
  v_group_id uuid;
  v_declared_people_count integer;
begin
  select * into v_profile
  from profiles
  where id = p_creator_id;

  if not found then
    raise exception 'Profil introuvable.';
  end if;

  if p_gender_rule = 'Hommes seulement' and v_profile.gender <> 'Homme' then
    raise exception 'Le type de coloc choisi ne correspond pas au profil.';
  end if;

  if p_gender_rule = 'Femmes seulement' and v_profile.gender <> 'Femme' then
    raise exception 'Le type de coloc choisi ne correspond pas au profil.';
  end if;

  if p_available_spots < 0 or p_available_spots > p_capacity then
    raise exception 'Le nombre de places disponibles doit être entre 0 et le nombre total de places.';
  end if;

  select count(*) into v_declared_people_count
  from jsonb_array_elements(p_existing_people) as person
  where nullif(trim(person->>'first_name'), '') is not null;

  if 1 + v_declared_people_count + p_available_spots > p_capacity then
    raise exception 'Les personnes déjà présentes et les places disponibles dépassent le total.';
  end if;

  insert into groups (
    creator_id,
    name,
    school_group,
    capacity,
    available_spots,
    gender_rule,
    city,
    contact,
    notes
  )
  values (
    p_creator_id,
    'Coloc de ' || v_profile.first_name,
    p_school_group,
    p_capacity,
    p_available_spots,
    p_gender_rule,
    p_city,
    p_contact,
    p_notes
  )
  returning id into v_group_id;

  insert into group_members (group_id, profile_id)
  values (v_group_id, p_creator_id);

  insert into group_people (group_id, first_name, school_group, avatar, is_creator)
  values (v_group_id, v_profile.first_name, v_profile.school_group, v_profile.avatar, true);

  insert into group_people (group_id, first_name, school_group, is_creator)
  select
    v_group_id,
    nullif(trim(person->>'first_name'), ''),
    coalesce(nullif(trim(person->>'school_group'), ''), 'Autre'),
    false
  from jsonb_array_elements(p_existing_people) as person
  where nullif(trim(person->>'first_name'), '') is not null;

  return v_group_id;
end;
$$;

create or replace function update_coloc_group(
  p_group_id uuid,
  p_editor_id uuid,
  p_school_group text,
  p_capacity integer,
  p_available_spots integer,
  p_gender_rule text,
  p_city text,
  p_contact text,
  p_notes text,
  p_existing_people jsonb default '[]'::jsonb
)
returns void
language plpgsql
as $$
declare
  v_profile profiles%rowtype;
  v_group groups%rowtype;
  v_declared_people_count integer;
begin
  select * into v_profile
  from profiles
  where id = p_editor_id;

  if not found then
    raise exception 'Profil introuvable.';
  end if;

  select * into v_group
  from groups
  where id = p_group_id;

  if not found then
    raise exception 'Groupe introuvable.';
  end if;

  if v_group.creator_id <> p_editor_id then
    raise exception 'Seul le créateur peut modifier ce groupe.';
  end if;

  if p_gender_rule = 'Hommes seulement' and v_profile.gender <> 'Homme' then
    raise exception 'Le type de coloc choisi ne correspond pas au profil.';
  end if;

  if p_gender_rule = 'Femmes seulement' and v_profile.gender <> 'Femme' then
    raise exception 'Le type de coloc choisi ne correspond pas au profil.';
  end if;

  if p_available_spots < 0 or p_available_spots > p_capacity then
    raise exception 'Le nombre de places disponibles doit être entre 0 et le nombre total de places.';
  end if;

  select count(*) into v_declared_people_count
  from jsonb_array_elements(p_existing_people) as person
  where nullif(trim(person->>'first_name'), '') is not null;

  if 1 + v_declared_people_count + p_available_spots > p_capacity then
    raise exception 'Les personnes déjà présentes et les places disponibles dépassent le total.';
  end if;

  update groups
  set school_group = p_school_group,
      capacity = p_capacity,
      available_spots = p_available_spots,
      gender_rule = p_gender_rule,
      city = p_city,
      contact = p_contact,
      notes = p_notes
  where id = p_group_id;

  delete from group_people
  where group_id = p_group_id
    and is_creator = false;

  update group_people
  set first_name = v_profile.first_name,
      school_group = v_profile.school_group,
      avatar = v_profile.avatar
  where group_id = p_group_id
    and is_creator = true;

  insert into group_people (group_id, first_name, school_group, is_creator)
  select
    p_group_id,
    nullif(trim(person->>'first_name'), ''),
    coalesce(nullif(trim(person->>'school_group'), ''), 'Autre'),
    false
  from jsonb_array_elements(p_existing_people) as person
  where nullif(trim(person->>'first_name'), '') is not null;
end;
$$;

grant execute on function create_coloc_group(
  uuid,
  text,
  integer,
  integer,
  text,
  text,
  text,
  text,
  jsonb
) to anon;

grant execute on function update_coloc_group(uuid, uuid, text, integer, integer, text, text, text, text, jsonb) to anon;

alter table profiles enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table group_people enable row level security;

drop policy if exists "profiles are readable" on profiles;
create policy "profiles are readable"
  on profiles for select
  using (true);

drop policy if exists "profiles can be created" on profiles;
create policy "profiles can be created"
  on profiles for insert
  with check (true);

drop policy if exists "groups are readable" on groups;
create policy "groups are readable"
  on groups for select
  using (true);

drop policy if exists "groups can be created" on groups;
create policy "groups can be created"
  on groups for insert
  with check (true);

drop policy if exists "groups can be updated" on groups;
create policy "groups can be updated"
  on groups for update
  using (true)
  with check (true);

drop policy if exists "members are readable" on group_members;
create policy "members are readable"
  on group_members for select
  using (true);

drop policy if exists "members can be created" on group_members;
create policy "members can be created"
  on group_members for insert
  with check (true);

drop policy if exists "group people are readable" on group_people;
create policy "group people are readable"
  on group_people for select
  using (true);

drop policy if exists "group people can be created" on group_people;
create policy "group people can be created"
  on group_people for insert
  with check (true);

drop policy if exists "group people can be updated" on group_people;
create policy "group people can be updated"
  on group_people for update
  using (true)
  with check (true);

drop policy if exists "group people can be deleted" on group_people;
create policy "group people can be deleted"
  on group_people for delete
  using (true);

notify pgrst, 'reload schema';
