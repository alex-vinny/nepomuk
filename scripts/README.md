# azure-connector/scripts — helpers standalone

Scripts que usam a lib do azure-connector (`lib/config.js`, `lib/api.js`) — PAT/org
carregados de lá, sem hardcode.

| Script | Uso |
|--------|-----|
| _(vazio)_ | Sem scripts no momento. |

> **Movido:** o antigo `tag-compare.js` (comparar duas tags de um repo) foi portado para o
> tool **git-diff-analysis** como subcomando Python `tags`:
> `python git_diff_analysis.py tags "<project>" "<repo>" "<oldTag>" "<newTag>"`
> (ou `... tags "<repo-url>" "<oldTag>" "<newTag>"`). Ver o README do tool
> **git-diff-analysis**.
