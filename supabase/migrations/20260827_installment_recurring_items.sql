-- Fitur: Item "Cicilan" di Menu Ceklis (Pengingat Berulang)
-- Tambah field baru di recurring_items untuk mendukung item cicilan (jumlah pembayaran terbatas),
-- selain item checklist biasa (tanpa batas akhir, perilaku lama).

alter table public.recurring_items
  add column if not exists kind text not null default 'checklist',
  add column if not exists repeat_mode text,
  add column if not exists total_occurrences integer,
  add column if not exists paid_occurrences integer not null default 0,
  add column if not exists end_date text,
  add column if not exists completed_at timestamptz;

alter table public.recurring_items
  drop constraint if exists recurring_items_kind_check;
alter table public.recurring_items
  add constraint recurring_items_kind_check
    check (kind in ('checklist', 'installment'));

alter table public.recurring_items
  drop constraint if exists recurring_items_repeat_mode_check;
alter table public.recurring_items
  add constraint recurring_items_repeat_mode_check
    check (repeat_mode is null or repeat_mode in ('count', 'until_date'));

-- Item lama otomatis jadi kind='checklist' (backward compatible, default di atas sudah menangani ini).

-- Bug terpisah (dicatat di spec-ceklis-cicilan-1.md bagian 2.2): recurring_items.wallet_id masih
-- ON DELETE CASCADE ke wallets, jadi kalau dompet acuan item dihapus, item ikut kehapus permanen.
-- Diperbaiki di sini jadi SET NULL supaya "ceklis tiba-tiba hilang" tidak terulang, termasuk untuk cicilan baru.
alter table public.recurring_items drop constraint if exists fk_recurring_items_wallet;
alter table public.recurring_items
  add constraint fk_recurring_items_wallet
  foreign key (wallet_id)
  references public.wallets(id)
  on delete set null;
