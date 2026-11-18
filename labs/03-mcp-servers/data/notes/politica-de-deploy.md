# Política de deploy

Deploy em produção acontece de terça a quinta-feira, antes das 16h.

Deploy na sexta-feira ou em véspera de feriado exige aprovação da gerência de engenharia.

Todo deploy precisa de um plano de rollback testado. O rollback tem que caber em 10 minutos.

Mudança de banco de dados vai em um deploy separado, antes do código que depende dela.
