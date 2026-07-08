-- ============================================================
--  DUELS DE L'AIGLE — pierre / feuille / ciseaux entre joueurs
--  À exécuter UNE FOIS dans Supabase (SQL Editor).
--
--  Principe : mise libre (le provocateur choisit les points, 1..500),
--  adversaire au choix. SOMME NULLE : le gagnant prend la mise au perdant
--  (nul = 0), donc les totaux du groupe ne gonflent pas — ça resserre juste
--  le classement.
--
--  Anti-triche : le coup du provocateur (move_a) est MASQUÉ tant que le duel
--  n'est pas résolu (vue `duels_pub`), et la résolution se fait CÔTÉ SERVEUR
--  (fonction `play_duel`). Impossible de lire le coup adverse via l'API.
-- ============================================================

create table if not exists public.duels (
  id          uuid primary key default gen_random_uuid(),
  challenger  uuid not null references auth.users(id) on delete cascade,
  opponent    uuid not null references auth.users(id) on delete cascade,
  stake       int  not null check (stake in (10, 20, 30)),
  move_a      text not null check (move_a in ('pierre','feuille','ciseaux')),
  move_b      text          check (move_b in ('pierre','feuille','ciseaux')),
  status      text not null default 'pending' check (status in ('pending','done')),
  result      text          check (result in ('a','b','tie')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  constraint duel_diff check (challenger <> opponent)
);

alter table public.duels enable row level security;

-- Le provocateur crée son duel, uniquement au nom de son propre compte.
drop policy if exists duels_insert on public.duels;
create policy duels_insert on public.duels for insert to authenticated
  with check (auth.uid() = challenger and status = 'pending'
              and move_b is null and result is null);

-- Pas d'accès direct en lecture/écriture : la lecture passe par la vue
-- `duels_pub` (coup masqué), la réponse par la fonction `play_duel`.
revoke select, update, delete on public.duels from authenticated, anon;

-- Vue publique : masque move_a tant que le duel n'est pas résolu.
-- security_invoker=off (SECURITY DEFINER) -> voit toutes les lignes, ce qui
-- garde le classement global cohérent pour tous les joueurs.
create or replace view public.duels_pub with (security_invoker = off) as
  select id, challenger, opponent, stake,
    case when status = 'done' or auth.uid() = challenger
         then move_a else null end as move_a,
    move_b, status, result, created_at, resolved_at
  from public.duels;
grant select on public.duels_pub to authenticated;

-- Résolution côté serveur : l'adversaire joue son coup, le serveur tranche.
create or replace function public.play_duel(p_duel uuid, p_move text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare d public.duels; res text;
begin
  select * into d from public.duels where id = p_duel for update;
  if not found then raise exception 'Duel introuvable'; end if;
  if d.opponent <> auth.uid() then raise exception 'Ce duel ne t''est pas destiné'; end if;
  if d.status <> 'pending' then raise exception 'Duel déjà joué'; end if;
  -- Réponse obligatoire sous 24 h : passé ce délai, le défi est perdu par forfait
  -- (les points vont au provocateur, comptabilisés côté classement). On refuse donc
  -- toute réponse tardive pour que le forfait ne puisse pas être « annulé » après coup.
  if now() - d.created_at > interval '24 hours' then
    raise exception 'Délai de réponse dépassé (24 h) : défi perdu par forfait';
  end if;
  if p_move not in ('pierre','feuille','ciseaux') then raise exception 'Coup invalide'; end if;

  if d.move_a = p_move then
    res := 'tie';
  elsif (d.move_a = 'pierre'  and p_move = 'ciseaux')
     or (d.move_a = 'feuille' and p_move = 'pierre')
     or (d.move_a = 'ciseaux' and p_move = 'feuille') then
    res := 'a';   -- le provocateur gagne
  else
    res := 'b';   -- l'adversaire (celui qui répond) gagne
  end if;

  update public.duels
     set move_b = p_move, result = res, status = 'done', resolved_at = now()
   where id = p_duel;
  return res;
end; $$;

revoke all on function public.play_duel(uuid, text) from public, anon;
grant execute on function public.play_duel(uuid, text) to authenticated;
