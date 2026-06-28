-- Staging: typed, cleaned orders from the raw seed.
select
    order_id::int        as order_id,
    customer::text       as customer,
    amount::numeric      as amount,
    order_date::date     as order_date
from {{ ref('raw_orders') }}
