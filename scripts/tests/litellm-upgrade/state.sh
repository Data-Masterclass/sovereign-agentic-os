# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
source "$(dirname "$0")/lib.sh"
echo "  version: $(curl -sI $B/health/liveliness | grep -i '^x-litellm-version' | tr -d '\r' | cut -d' ' -f2)"
for k in $AGENT_KEY sk-os-upg1; do adm "$B/key/info?key=$k" | python3 -c "
import json,sys
d=json.load(sys.stdin); i=d.get('info') or {}
print('  key', i.get('key_alias'), {k:i.get(k) for k in ('models','max_budget','budget_duration','budget_reset_at','rpm_limit','tpm_limit','max_parallel_requests','spend')}, (i.get('metadata') or {}).get('allowed_tools')) if i else print('  key lookup failed:', str(d)[:200])"; done
adm "$B/key/list?return_full_object=true&include_team_keys=true&size=100" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  keys:', d.get('total_count'), sorted(str(k.get('key_alias')) for k in d.get('keys',[]))[:8], '...')"
adm $B/team/list | python3 -c "import json,sys; d=json.load(sys.stdin); print('  teams:', [(t.get('team_alias'), t.get('max_budget'), t.get('budget_duration')) for t in (d if isinstance(d,list) else d.get('teams',[]))])"
adm $B/model/info | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('  models:', len(d), '| stored in DB:', [m['model_name'] for m in d if (m.get('model_info') or {}).get('db_model')])"
dbmodel_call $MASTER | cut -c1-44 | sed 's/^/  /'
printf '  shared key chat: HTTP '; chat $AGENT_KEY sovereign-default hello; echo
printf '  system key chat: HTTP '; chat sk-os-upg1 sovereign-default hello; echo
adm "$B/spend/logs?api_key=sk-os-upg1" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  spend log rows for the system key:', len(d))"
docker exec gwpg psql -U litellm -d litellm -At -c "select 'tables: '||count(*) from information_schema.tables where table_schema='public'" -c "select 'migrations applied: '||count(*)||', failed: '||count(*) filter (where finished_at is null and rolled_back_at is null) from _prisma_migrations" | sed 's/^/  /'
