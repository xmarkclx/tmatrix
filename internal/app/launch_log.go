package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
)

type launchLog struct {
	mu      sync.Mutex
	path    string
	limit   int64
	backups int
	file    *os.File
	size    int64
}

func newLaunchLog(path string, limit int64, backups int) (*launchLog, error) {
	if limit <= 0 || backups < 1 {
		return nil, errors.New("invalid launch log limits")
	}
	l := &launchLog{path: path, limit: limit, backups: backups}
	if err := l.inspect(); err != nil {
		return nil, err
	}
	for i := 0; i <= backups; i++ {
		p := l.name(i)
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
			continue
		}
		f, err := openPrivateLog(p)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		if err == nil && info.Size() > limit {
			tail := make([]byte, limit)
			_, err = f.ReadAt(tail, info.Size()-limit)
			if err == nil {
				_, err = f.WriteAt(tail, 0)
			}
			if err == nil {
				err = f.Truncate(limit)
			}
		}
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	if err := l.open(); err != nil {
		return nil, err
	}
	if l.size >= l.limit {
		if err := l.rotate(); err != nil {
			l.Close()
			return nil, err
		}
	}
	return l, nil
}

func (l *launchLog) name(index int) string {
	if index == 0 {
		return l.path
	}
	return l.path + "." + strconv.Itoa(index)
}

func (l *launchLog) inspect() error {
	for i := 0; i <= l.backups; i++ {
		info, err := os.Lstat(l.name(i))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("launch log %s must be a regular file", l.name(i))
		}
	}
	return nil
}

func openPrivateLog(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	opened, err := f.Stat()
	entry, entryErr := os.Lstat(path)
	if err != nil || entryErr != nil || !entry.Mode().IsRegular() || !os.SameFile(opened, entry) {
		f.Close()
		return nil, errors.New("launch log must be a regular file")
	}
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func (l *launchLog) open() error {
	f, err := openPrivateLog(l.path)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	l.file, l.size = f, info.Size()
	return nil
}

func (l *launchLog) rotate() error {
	if err := l.inspect(); err != nil {
		return err
	}
	if err := l.file.Close(); err != nil {
		return err
	}
	l.file = nil
	if err := os.Remove(l.name(l.backups)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for i := l.backups - 1; i >= 0; i-- {
		if err := os.Rename(l.name(i), l.name(i+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return l.open()
}

func (l *launchLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	written := 0
	for len(data) > 0 {
		if l.file == nil {
			return written, os.ErrClosed
		}
		if l.size >= l.limit {
			if err := l.rotate(); err != nil {
				return written, err
			}
		}
		chunk := data[:min(int64(len(data)), l.limit-l.size)]
		n, err := l.file.Write(chunk)
		l.size += int64(n)
		written += n
		data = data[n:]
		if err != nil {
			return written, err
		}
		if n != len(chunk) {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func (l *launchLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}

type engineLogOutput struct {
	mu     sync.Mutex
	log    *launchLog
	failed bool
	errors chan error
}

func (o *engineLogOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.failed {
		if _, err := o.log.Write(data); err != nil {
			o.failed = true
			o.errors <- err
		}
	}
	// Keep draining the child pipes so a logging failure cannot interrupt workers.
	return len(data), nil
}
