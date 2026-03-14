package app

import (
	"bufio"
	"errors"
	"io"
)

func readArrowKey(reader *bufio.Reader) (byte, byte, bool, error) {
	next, err := reader.ReadByte()
	if err != nil {
		return 0, 0, false, err
	}
	if next != '[' {
		return next, 0, false, nil
	}

	direction, err := reader.ReadByte()
	if err != nil {
		return next, 0, false, err
	}

	if direction != 'A' && direction != 'B' {
		return next, direction, false, nil
	}

	return next, direction, true, nil
}

func isEOF(err error) bool {
	return errors.Is(err, io.EOF)
}
