-- Daybreak Wire — 접근 권한 (초대제 → 구독으로 확장)
--
-- ⚠️  schema.sql 과 분리해 둔 이유: 이 파일의 2단계는 user_state 정책을 조여서
--     승인되지 않은 사람의 읽기·쓰기를 막습니다. 순서를 건너뛰고 실행하면
--     본인 계정까지 자기 단어장에 접근하지 못하게 됩니다.
--
--     반드시 STAGING 프로젝트에서 먼저 1→2 순서대로 실행해 확인한 뒤,
--     운영 프로젝트에 적용하세요.
--
-- 권한 모델을 "초대 여부"가 아니라 plan/valid_until 로 잡아둔 것은 나중에
-- 구독을 붙일 때 스키마를 갈아엎지 않기 위해서입니다.
--   plan 'free'    — 신청만 한 상태
--        'invited' — 초대로 열어준 무기한 사용자
--        'pro'     — 유료 구독자 (valid_until 로 만료 관리)

-- ───────────────────────────────────────────────────────────────────────
-- 1단계. 계정 테이블 — 여기까지는 기존 동작에 영향이 없습니다.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.accounts (
  email        text primary key,
  plan         text not null default 'free'    check (plan   in ('free', 'invited', 'pro')),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'blocked')),
  -- null = 만료 없음(초대제). 구독자는 결제 주기 끝을 넣습니다.
  valid_until  timestamptz,
  is_admin     boolean not null default false,
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  note         text
);

-- 로그인한 사람의 이메일. 대소문자 차이로 권한이 갈리지 않도록 항상 소문자.
create or replace function public.current_email() returns text
  language sql stable
  as $$ select lower(auth.jwt() ->> 'email') $$;

-- security definer: 정책 안에서 accounts 를 읽어야 하는데, accounts 자신도
-- RLS 가 걸려 있어 호출자 권한으로는 볼 수 없기 때문입니다.
create or replace function public.is_approved() returns boolean
  language sql stable security definer set search_path = public
  as $$
    select exists (
      select 1 from public.accounts a
      where a.email = public.current_email()
        and a.status = 'approved'
        and (a.valid_until is null or a.valid_until > now())
    )
  $$;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$
    select exists (
      select 1 from public.accounts a
      where a.email = public.current_email() and a.is_admin
    )
  $$;

alter table public.accounts enable row level security;

-- 본인 행만 봅니다. 관리자는 전체를 봅니다(관리 화면).
drop policy if exists "accounts_select" on public.accounts;
create policy "accounts_select" on public.accounts for select
  using (email = public.current_email() or public.is_admin());

-- 사용 신청: 본인 이메일로, pending/free 로만 넣을 수 있습니다.
-- 스스로 approved 나 is_admin 을 넣는 건 이 체크에서 막힙니다.
drop policy if exists "accounts_request_own" on public.accounts;
create policy "accounts_request_own" on public.accounts for insert
  with check (
    email = public.current_email()
    and status = 'pending' and plan = 'free'
    and is_admin = false and valid_until is null
  );

-- 승인·거절·구독 변경은 관리자만.
drop policy if exists "accounts_admin_update" on public.accounts;
create policy "accounts_admin_update" on public.accounts for update
  using (public.is_admin()) with check (public.is_admin());

-- ★ 2단계로 넘어가기 전에 반드시: 본인을 관리자 겸 승인 상태로 넣습니다.
--   아래 이메일을 본인 것으로 바꾸고 실행하세요. 이걸 빠뜨리면 잠깁니다.
insert into public.accounts (email, plan, status, is_admin, decided_at, note)
values (lower('lineggi08@gmail.com'), 'invited', 'approved', true, now(), 'owner')
on conflict (email) do update
  set plan = 'invited', status = 'approved', is_admin = true, decided_at = now();

-- 이미 쓰고 있던 사람이 있다면 여기에 함께 넣어 두세요.
-- insert into public.accounts (email, plan, status, decided_at, note)
-- values (lower('someone@example.com'), 'invited', 'approved', now(), '초대')
-- on conflict (email) do nothing;

-- ───────────────────────────────────────────────────────────────────────
-- 2단계. user_state 를 승인된 사람에게만 — 여기서부터 실제로 막힙니다.
--
-- 1단계의 owner insert 가 끝났는지 먼저 확인하세요:
--     select email, status, is_admin from public.accounts;
-- ───────────────────────────────────────────────────────────────────────

drop policy if exists "user_state_select_own" on public.user_state;
create policy "user_state_select_own" on public.user_state for select
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "user_state_insert_own" on public.user_state;
create policy "user_state_insert_own" on public.user_state for insert
  with check (auth.uid() = user_id and public.is_approved());

drop policy if exists "user_state_update_own" on public.user_state;
create policy "user_state_update_own" on public.user_state for update
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

-- ───────────────────────────────────────────────────────────────────────
-- 되돌리기 — 잠겼거나 초대제를 걷어낼 때. schema.sql 의 원래 정책으로 복구.
-- ───────────────────────────────────────────────────────────────────────
-- drop policy if exists "user_state_select_own" on public.user_state;
-- create policy "user_state_select_own" on public.user_state for select
--   using (auth.uid() = user_id);
-- drop policy if exists "user_state_insert_own" on public.user_state;
-- create policy "user_state_insert_own" on public.user_state for insert
--   with check (auth.uid() = user_id);
-- drop policy if exists "user_state_update_own" on public.user_state;
-- create policy "user_state_update_own" on public.user_state for update
--   using (auth.uid() = user_id) with check (auth.uid() = user_id);
