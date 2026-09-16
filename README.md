# ⚡ FLASHMAP

Sala geoespacial ao vivo para aulas, cursos e eventos interativos.

## Objetivo imediato
Curso de QGIS com capacidade-alvo de **500 participantes conectados**, com palco controlado para poucos publicadores simultâneos.

## MVP já publicado
- Interface responsiva
- Modo apresentação
- Mapa Leaflet/OpenStreetMap
- Flash estilo Mentimeter: pergunta + resposta aberta + nuvem
- Chat local de demonstração
- Fila/mão levantada na interface
- Solicitação real de permissão de câmera e microfone

## Arquitetura de produção
- **GitHub Pages**: frontend estático
- **Firebase Authentication**: identidade / convidado
- **Firebase Realtime Database**: presença, chat, mãos, estado dos Flashes e sincronização leve em tempo real
- **Firebase Storage**: imagens e vídeos curtos do chat (requer Blaze)
- **LiveKit Cloud**: WebRTC/SFU para palco, áudio e vídeo
- **Leaflet/MapLibre**: mapas e ferramentas geoespaciais

## Regra para 500
500 conectados não significa 500 câmeras publicando. O desenho inicial é 500 participantes na sala e palco com poucos publicadores simultâneos (host/convidados), reduzindo banda, custo e risco.

## Próximas etapas críticas
1. Criar/conectar projeto Firebase e inserir `firebaseConfig`.
2. Ativar Authentication e Realtime Database.
3. Implementar presença real, chat e Flash sincronizados.
4. Criar conta/projeto LiveKit e endpoint seguro de geração de token.
5. Integrar palco WebRTC.
6. Adicionar desenho/anotações e respostas diretamente no mapa.
7. Testar carga em degraus antes do curso.

## Segurança
Nunca colocar `LIVEKIT_API_SECRET`, service-account do Firebase ou qualquer segredo no JavaScript público/GitHub Pages. Tokens de sala devem ser emitidos por backend seguro.
