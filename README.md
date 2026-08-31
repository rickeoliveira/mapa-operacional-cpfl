# Mapa Operacional CPFL

Aplicação web para pesquisar ativos da rede elétrica por número operativo, visualizar itens por região, filtrar por tipo e alimentador e iniciar rotas até um ativo.

## Dados

Os CSVs de origem não são versionados. Coloque-os em `data/` usando os nomes esperados pelo importador:

- `ed_capacitor.csv`
- `ed_fuse.csv`
- `ed_oh_transformer.csv`
- `ed_recloser.csv`
- `ed_regulator.csv`
- `ed_switch.csv`

## Configuração

A aplicação lê `DATABASE_URL` de um arquivo `.env` no diretório-pai. Para importar os dados e iniciar o serviço:

```bash
node server.js import data
node server.js
```

Por padrão, o serviço escuta na porta 2223. Use `CPFL_MAP_PORT` para definir outra porta.
