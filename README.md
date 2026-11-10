# Mapa Operacional CPFL

Aplicação web para pesquisar ativos da rede elétrica por número operativo, visualizar itens por região, filtrar por tipo e alimentador e iniciar rotas até um ativo.

## Dados

Os dados operacionais não são versionados. O importador recebe uma pasta-raiz contendo as subpastas `1` a `15`; em cada uma delas devem estar os arquivos exportados:

- `ed_capacitor.txt`, `ed_fuse.txt`, `ed_oh_transformer.txt`, `ed_recloser.txt`, `ed_regulator.txt`, `ed_switch.txt` e `ed_ug_switch.txt`;
- `ed_oh_primary_conductor.txt` para os trechos da rede por alimentador.

Os equipamentos são atualizados e os trechos da rede são carregados em tabela separada. No mapa, cada alimentador recebe uma cor determinística e pode ser filtrado individualmente.

## Configuração

A aplicação lê `DATABASE_URL` de um arquivo `.env` no diretório-pai. Para importar os dados e iniciar o serviço:

```bash
node server.js import /caminho/para/1.1
node server.js
```

Por padrão, o serviço escuta na porta 2223. Use `CPFL_MAP_PORT` para definir outra porta.

## Monitoramento de acessos

O mapa registra somente identificadores aleatórios do navegador, sem IP ou dados pessoais. O servidor mantém sessões ativas por 90 segundos para medir acessos simultâneos e cria um registro diário por visitante para os acumulados diário, mensal e anual.

O arquivo [grafana/dashboard.json](grafana/dashboard.json) é provisionado para usar a fonte de dados Prometheus. O Prometheus deve coletar o endpoint `/metrics` do mapa a cada 10 segundos.
