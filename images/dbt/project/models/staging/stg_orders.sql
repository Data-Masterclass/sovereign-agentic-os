-- Staging: typed, cleaned orders from the raw seed.
-- Trino/Iceberg dialect: `CAST(x AS <trino type>)` — NOT Postgres `x::type`. Trino has
-- no `::` cast operator and no `text`/`numeric` types, so the old form failed to compile
-- and the marts could never materialize.
select
    cast(order_id as integer)      as order_id,
    cast(customer as varchar)      as customer,
    cast(amount as decimal(10, 2)) as amount,
    cast(order_date as date)       as order_date
from {{ ref('raw_orders') }}
