# sales-attribution

API que recebe webhooks de pedido e de estorno e atribui cada venda a no máximo um criador.

## Rodar

Use Node 22 ou mais novo.

```bash
npm install
npm run dev        # http://127.0.0.1:3000, banco em sales.db
npm test
npm run typecheck
npm run bench      # carga e estresse contra o servidor real
```

`PORT` e `DATABASE_PATH` mudam a porta e o arquivo do banco. O banco começa com dois criadores: `ana` (cupom `ANA10`) e `bruno` (cupom `BRUNO10`).

## Rotas

| Rota | O que faz |
| --- | --- |
| `POST /webhooks/orders` | Recebe um pedido |
| `POST /webhooks/refunds` | Recebe um estorno |
| `GET /orders/:id` | Mostra o pedido, o criador, os lançamentos e os estornos |
| `GET /creators/:id/sales` | Mostra venda, estornado e líquido do criador |

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

```json
{ "id": "r1", "order_id": 5001, "amount": "25.00", "currency": "BRL" }
```

Os webhooks respondem 200 com `outcome` e o estado do pedido. Um payload inválido recebe 422.

## Regra de atribuição

A regra está em [src/attribution.ts](src/attribution.ts). Os testes estão em [tests/attribution.test.ts](tests/attribution.test.ts).

1. O cupom do pedido pertence a um criador: a venda é dele.
2. Sem cupom de criador, a API usa a UTM: `utm_source=conty` e `utm_content` igual ao identificador do criador.
3. Sem cupom e sem UTM, a venda fica sem criador.

Desempate: se o cupom indica um criador e a UTM indica outro, o cupom vence. O cliente digita o cupom no checkout. A UTM só registra o último clique.

A API define o criador na primeira chegada do pedido e não o muda depois.

## Como cada caso é tratado

| Caso | O que a API faz |
| --- | --- |
| Pedido repetido | Ignora. A chave é o `id` do pedido. |
| Pedido `pending` | Guarda o pedido. Lança a venda quando ele chega como `paid`. |
| Pedido `cancelled` | Não lança venda. |
| Estorno | Insere um lançamento negativo. Nenhum lançamento é apagado. |
| Estorno parcial | Guarda o valor pedido e o valor aplicado. |
| Estorno acima do saldo | Aplica só o saldo. A soma dos estornos não passa do valor da venda. |
| Estorno repetido | Ignora. A chave é o `id` do estorno, que é obrigatório. |
| Estorno antes do pedido | Guarda como `pending`. Aplica quando o pedido chega como `paid`, em ordem de chegada. |
| Estorno de pedido cancelado ou em outra moeda | Guarda como `discarded`, com o motivo. |

O dinheiro fica em centavos inteiros.

Cada webhook roda em uma transação síncrona, então duas requisições não se misturam no mesmo processo. O banco também recusa pedido, venda e estorno duplicados com `UNIQUE`.

## O que ficou de fora

- Assinatura HMAC do webhook.
- Cadastro de criadores pela API.
- Mudança de valor ou de cupom em um pedido já recebido.
- Mais de um processo no mesmo banco.
- Prazo para um estorno `pending` cujo pedido nunca chega.

## Uso de IA

O Claude Code (Claude Opus 5.5) escreveu o código, os testes e este README.

Eu tomei as decisões de desenho antes do código: o desempate, o tratamento de cada caso da tabela acima, os centavos inteiros, Fastify com Zod, SQLite e a assinatura HMAC fora do escopo.

Revisei as queries SQL e pedi o plano de execução de cada uma. Dessa revisão saíram um índice e a correção de maiúsculas no cupom. Não revisei o resto do código linha a linha.
