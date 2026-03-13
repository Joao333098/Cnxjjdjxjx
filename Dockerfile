# Usamos a imagem oficial do Playwright que já contém todas as dependências do sistema operacional necessárias para rodar o Chromium.
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependência primeiro para aproveitar o cache do Docker
COPY package*.json ./

# Instala as dependências do projeto
RUN npm install

# Copia o restante do código da aplicação
COPY . .

# Constrói o frontend (Vite)
RUN npm run build

# Expõe a porta que o Express vai rodar
EXPOSE 3000

# Comando para iniciar o servidor em produção
CMD ["npm", "start"]
