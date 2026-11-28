-- QA applied and verified on 2026-11-28. Production requires release validation.
create index if not exists favorite_meals_client_id_idx on public.favorite_meals (client_id);
create index if not exists food_items_entry_client_idx on public.food_items (entry_id,client_id);
create index if not exists referrals_referred_client_idx on public.referrals (referred_client_id);
