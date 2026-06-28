-- Mart: revenue + order count per day. Consumed by the Cube semantic layer.
select
    order_date,
    sum(amount)  as revenue,
    count(*)     as orders
from {{ ref('stg_orders') }}
group by order_date
order by order_date
