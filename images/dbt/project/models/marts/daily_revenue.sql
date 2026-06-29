-- Mart: revenue + order count per day. Consumed by the Cube semantic layer.
-- Incremental Iceberg table: merge upserts each day's row by order_date so the
-- mart refreshes cheaply (no full rebuild) — the Trino/Iceberg field convention.
{{ config(materialized='incremental', incremental_strategy='merge', unique_key='order_date') }}
select
    order_date,
    sum(amount)  as revenue,
    count(*)     as orders,
    max(order_date) as updated_at   -- Cube refresh-key column (max per mart)
from {{ ref('stg_orders') }}
group by order_date
