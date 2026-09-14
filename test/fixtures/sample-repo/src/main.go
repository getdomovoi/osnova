package main

import "fmt"

const MaxPorts = 16

type Server struct {
	Port int
}

func (s *Server) Start() string {
	return fmt.Sprintf("start %d", s.Port)
}

func buildServer(port int) *Server {
	return &Server{Port: port}
}

func main() {
	srv := buildServer(9)
	fmt.Println(srv.Start())
}
