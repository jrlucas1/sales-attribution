# sales-attribution

API que recebe webhooks de pedido e de estorno de uma loja e atribui cada venda a no máximo um criador.

## Rodar

Precisa de Node 22 ou mais novo.

```bash
npm install
npm run dev        # sobe em http://127.0.0.1:3000, banco em sales.db
npm test
npm run typecheck
```

`PORT` e `DATABASE_PATH` mudam a porta e o arquivo do banco. Na primeira subida o banco recebe dois criadores de exemplo: `ana` (cupom `ANA10`, UTM `ana`) e `bruno` (cupom `BRUNO10`, UTM `bruno`).

## Rotas

| Rota | O que faz |
| --- | --- |
| `POST /webhooks/orders` | Ingestão de pedido |
| `POST /webhooks/refunds` | Ingestão de estorno |
| `GET /orders/:id` | Pedido, criador, lançamentos e estornos (inclusive os pendentes) |
| `GET /creators/:id/sales` | Venda bruta, estornado e líquido do criador, por moeda |

Pedido, seguindo o essencial de um pedido Shopify:

```json
{
  "id": 5001,
  "total_price": "199.90",
  "currency": "BRL",
  "status": "paid",
  "discount_codes": [{ "code": "ANA10" }],
  "landing_site": "/produtos/tenis?utm_source=conty&utm_content=bruno"
}
```

Estorno:

```json
{ "id": "r1", "order_id": 5001, "amount": "25.00", "currency": "BRL" }
```

Os dois webhooks respondem 200 com `outcome` e o estado atual do pedido. Payload inválido responde 422 e não grava nada.

## Regra de atribuição

Fica inteira em [src/attribution.ts](src/attribution.ts), numa função pura, testada em [tests/attribution.test.ts](tests/attribution.test.ts).

1. **Cupom**: o primeiro cupom do pedido que pertence a algum criador.
2. **UTM**: `utm_source=conty` e `utm_content` igual ao identificador do criador.
3. Sem nenhum dos dois, a venda é gravada sem criador.

**Desempate: quando cupom e UTM apontam para criadores diferentes, o cupom vence.** O cupom é digitado no checkout, então é evidência direta da compra. A UTM é o último clique e pode ter sido herdada de um link qualquer.

A comparação não diferencia maiúsculas. O criador é decidido na primeira vez que o pedido chega e não muda depois.

## Como cada caso é tratado

**Pedido repetido.** A chave é o `id`. Reenvio não altera nada, mesmo com payload diferente; a resposta traz `outcome: "duplicate"`. A única mudança aceita é de status: `pending → paid` e `pending → cancelled`.

**Status.** Pedido `pending` é guardado com o criador já definido, mas só vira venda quando chega como `paid`. Pedido `cancelled` nunca vira venda.

**Histórico.** A tabela `ledger_entries` só recebe inserções: `+total` na venda e `-valor` em cada estorno. O líquido de um pedido ou de um criador é sempre a soma desses lançamentos, então um estorno reverte a atribuição sem apagar nada.

**Estorno parcial e limite.** Cada estorno guarda o valor pedido (`requested_cents`) e o valor aplicado (`applied_cents`). O aplicado é limitado ao saldo que resta no pedido, então a soma dos estornos nunca passa do valor da venda, e o excesso continua visível.

**Estorno repetido.** A chave é o `id` do estorno, que é obrigatório. Sem ele não dá para distinguir um reenvio de dois estornos de mesmo valor.

**Estorno antes do pedido.** Fica gravado como `pending` e aparece em `GET /orders/:id` mesmo sem o pedido. Quando o pedido chega como `paid`, os pendentes são aplicados em ordem de chegada, na mesma transação que lança a venda. O mesmo vale para estorno de pedido que ainda está `pending`.

**Estorno descartado.** Estorno de pedido cancelado ou em moeda diferente da do pedido é gravado com status `discarded` e o motivo, com valor aplicado zero.

**Dinheiro.** Centavos inteiros. A string decimal do payload é convertida na entrada.

**Concorrência.** `better-sqlite3` é síncrono e cada webhook roda numa transação sem `await` no meio, então duas requisições nunca se intercalam dentro de um processo. Como segunda defesa, o banco tem `UNIQUE` no id do pedido, no id do estorno, no lançamento de cada estorno e na venda de cada pedido.

## O que ficou de fora

- Verificação da assinatura HMAC do webhook.
- Cadastro de criadores por API (vêm de seed).
- Mudança de valor ou de cupom num pedido já recebido.
- Várias instâncias no mesmo banco. A garantia de concorrência vale para um processo; com Postgres e mais de uma instância seria preciso travar a linha do pedido ao aplicar estorno.
- Estorno pendente cujo pedido nunca chega fica pendente para sempre; não há expiração.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus 5.5).

As decisões de desenho foram minhas, tomadas uma a uma antes de qualquer código: cupom vence UTM, pedido sem criador é gravado, reenvio não troca a atribuição, pedido `pending` é guardado e só vira venda no `paid`, estorno exige `id`, estorno é limitado ao saldo e guarda o valor pedido, histórico em livro-razão só de inserção, estorno antecipado aplicado na mesma transação do pedido, centavos inteiros, Fastify com Zod, SQLite, assinatura HMAC fora do escopo. Também questionei se era preciso tratar concorrência e aceitei a resposta descrita acima.

Ainda não revisei o código linha a linha.
